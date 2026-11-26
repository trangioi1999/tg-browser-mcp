import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { WorkflowEngine } from '../../src/workflow/workflow-engine.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { selectTools } from '../../src/server/tool-registry.js';
import { TargetSchema } from '../../src/harness/target.js';
import { generatePlaywrightTest } from '../../src/testing/test-generator.js';
import { assertValidWorkflow } from '../../src/workflow/workflow-validator.js';
import { testHarness } from '../helpers.js';
import { formatSnapshot } from '../../src/snapshot/snapshot-engine.js';

describe('TGB-017 contracts', () => {
  it('accepts all container forms and rejects empty containers', () => {
    for (const within of [
      { ref: 'e1' },
      { role: 'form', name: 'Second' },
      { label: 'Billing' },
      { testId: 'card' },
      { selector: '#card' },
    ]) {
      expect(TargetSchema.parse({ role: 'button', within }).within).toEqual(within);
    }
    expect(TargetSchema.safeParse({ within: {} }).success).toBe(false);
    for (const tool of ALL_TOOLS.filter((t) => 'role' in t.input && 'selector' in t.input))
      expect(tool.input).toHaveProperty('within');
  });

  it('selects core tools with explicit enable/disable overrides', () => {
    const names = selectTools(ALL_TOOLS, {
      profile: 'core',
      enabled: ['workflow_execute'],
      disabled: ['browser_click'],
    }).map((t) => t.name);
    expect(names).toContain('browser_fill');
    expect(names).toContain('session_create');
    expect(names).toContain('browser_errors');
    expect(names).toContain('workflow_execute');
    expect(names).not.toContain('browser_click');
    expect(names).not.toContain('browser_double_click');
    expect(selectTools(ALL_TOOLS, { profile: 'core', enabled: [], disabled: [] })).toHaveLength(13);
  });

  it('generates scoped locators without executing hostile container strings', () => {
    const payload = 'Second ${globalThis.pwned = true}`\n"';
    const wf = assertValidWorkflow({
      name: 'scope',
      steps: [
        {
          id: 'click',
          action: 'click',
          session: 's',
          input: { role: 'button', name: 'Save', within: { role: 'form', name: payload } },
        },
      ],
    });
    const code = generatePlaywrightTest(wf);
    expect(code).toContain('.getByRole("form", { name:');
    expect(code).toContain('}).getByRole("button"');
    const source = ts.createSourceFile('generated.ts', code, ts.ScriptTarget.Latest, true);
    let templateCount = 0;
    const visit = (node: ts.Node) => {
      if (ts.isTemplateExpression(node) && node.getText(source).includes('pwned')) templateCount++;
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(templateCount).toBe(0);
    expect(ts.transpileModule(code, { reportDiagnostics: true }).diagnostics).toEqual([]);
  });

  it('reserves names atomically and releases only the owner leases', async () => {
    const h = testHarness();
    try {
      const release = h.sessions.acquireLeases(['a'], 'run:a');
      expect(() => h.sessions.acquireLeases(['b', 'a'], 'run:b')).toThrowError(
        expect.objectContaining({ code: 'SESSION_BUSY' }),
      );
      const b = h.sessions.acquireLeases(['b'], 'run:b');
      const otherProject = h.sessions.acquireLeases(['a'], 'run:c', 'other');
      release();
      const next = h.sessions.acquireLeases(['a'], 'run:next');
      release();
      expect(() => h.sessions.acquireLeases(['a'], 'run:third')).toThrowError(
        expect.objectContaining({ code: 'SESSION_BUSY' }),
      );
      next();
      b();
      otherProject();
    } finally {
      await h.close();
    }
  });

  it('leases sessions across workflow execution and forwards recorded scopes', async () => {
    const h = testHarness();
    const find = vi
      .spyOn(h.sessions, 'find')
      .mockImplementation(
        (name) => ({ id: name, name, project: h.config.project, pages: new Map() }) as never,
      );
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const click = vi.spyOn(h.actions, 'click').mockImplementation(async () => {
      await pending;
      return { message: 'clicked' } as never;
    });
    try {
      const engine = new WorkflowEngine(h);
      const workflow = (session: string) => ({
        name: 'lease',
        steps: [
          {
            id: 'click',
            session,
            action: 'click',
            input: { role: 'button', name: 'Save', within: { testId: 'second' } },
          },
        ],
      });
      const first = engine.start(workflow('a'));
      const second = await engine.start(workflow('a')).promise;
      expect(second.failure?.code).toBe('SESSION_BUSY');
      const independent = engine.start(workflow('b'));
      finish();
      expect((await first.promise).status).toBe('passed');
      expect((await independent.promise).status).toBe('passed');
      expect(click.mock.calls[0]?.[0]).toMatchObject({ within: { testId: 'second' } });
      expect((await engine.start(workflow('a')).promise).status).toBe('passed');
    } finally {
      finish();
      find.mockRestore();
      click.mockRestore();
      await h.close();
    }
  });

  it('releases reservations after session creation fails', async () => {
    const h = testHarness();
    const create = vi.spyOn(h.sessions, 'create').mockRejectedValue(new Error('launch failed'));
    try {
      const engine = new WorkflowEngine(h);
      const run = await engine.start({
        name: 'failure',
        steps: [{ id: 'wait', session: 'new', action: 'wait', input: { timeMs: 1 } }],
      }).promise;
      expect(run.status).toBe('failed');
      const release = h.sessions.acquireLeases(['new'], 'next');
      release();
    } finally {
      create.mockRestore();
      await h.close();
    }
  });

  it('reports incomplete formatted pages and clipped lines', () => {
    const snap = {
      id: 1,
      url: '',
      title: '',
      docId: 'd',
      complete: true,
      nodeCount: 1,
      truncatedByNodeLimit: false,
      nodes: [{ role: 'text', name: 'x'.repeat(1000) }],
    };
    expect(formatSnapshot(snap, { maxChars: 500 }).complete).toBe(false);
    expect(
      formatSnapshot(
        { ...snap, nodes: Array.from({ length: 50 }, () => ({ role: 'button', name: 'Example' })) },
        { maxChars: 500 },
      ).complete,
    ).toBe(false);
    expect(formatSnapshot({ ...snap, nodes: [] }, { maxChars: 500 }).complete).toBe(true);
  });
});
