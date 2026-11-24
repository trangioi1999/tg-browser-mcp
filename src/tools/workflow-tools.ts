import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, json, text, type ToolContext } from '../server/tool-registry.js';
import { validateWorkflow, assertValidWorkflow } from '../workflow/workflow-validator.js';
import { AssertionSchema, type Workflow } from '../workflow/workflow-schema.js';
import { compactRunSummary, junitReport, markdownReport } from '../testing/report-generator.js';
import { generatePlaywrightTest } from '../testing/test-generator.js';
import { AssertionEngine } from '../testing/assertion-engine.js';
import { TgError } from '../shared/errors.js';
import type { RunRecord } from '../workflow/workflow-engine.js';

const Definition = z
  .record(z.string(), z.unknown())
  .describe('Workflow definition JSON (see docs/WORKFLOWS.md)');
const Vars = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional();

function resolveWorkflow(
  a: { name?: string | undefined; definition?: Record<string, unknown> | undefined },
  c: ToolContext,
): Workflow {
  if (a.definition) return assertValidWorkflow(a.definition);
  if (a.name) return c.workflows.loadDefinition(a.name);
  throw new TgError('INVALID_ARGUMENT', 'Provide name (saved workflow) or definition');
}

export const workflowTools = [
  defineTool({
    name: 'workflow_create',
    title: 'Create workflow',
    description:
      'Validate and save a workflow definition (multi-session steps, variables, assertions, extraction).',
    category: 'workflow',
    profile: 'testing',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 10_000,
    input: { definition: Definition },
    handler: async (a, c) => {
      const r = validateWorkflow(a.definition);
      if (!r.valid || !r.workflow) throw new TgError('WORKFLOW_INVALID', r.errors.join('; '));
      const file = c.workflows.saveDefinition(r.workflow);
      return text(
        `✓ Saved workflow "${r.workflow.name}" (${r.workflow.steps.length} steps) to ${file}${r.warnings.length ? `\n⚠ ${r.warnings.join('\n⚠ ')}` : ''}`,
      );
    },
  }),
  defineTool({
    name: 'workflow_validate',
    title: 'Validate workflow',
    description:
      'Check a workflow for schema errors, unknown dependencies, missing inputs and undefined variables.',
    category: 'workflow',
    profile: 'testing',
    risk: 'read',
    readOnly: true,
    timeoutMs: 10_000,
    input: {
      definition: Definition.optional(),
      name: z.string().optional(),
      variables: z.array(z.string()).optional().describe('Variables provided at run time'),
    },
    handler: async (a, c) => {
      const def = a.definition ?? (a.name ? c.workflows.loadDefinition(a.name) : undefined);
      if (!def) throw new TgError('INVALID_ARGUMENT', 'Provide definition or name');
      const r = validateWorkflow(def, a.variables);
      return text(
        [
          r.valid ? '✓ Valid' : '✗ Invalid',
          ...r.errors.map((e) => `  error: ${e}`),
          ...r.warnings.map((w) => `  warning: ${w}`),
        ].join('\n'),
      );
    },
  }),
  defineTool({
    name: 'workflow_list',
    title: 'List workflows',
    description: 'Saved workflows and recent runs for the project.',
    category: 'workflow',
    profile: 'testing',
    risk: 'read',
    readOnly: true,
    timeoutMs: 10_000,
    input: {},
    handler: async (_a, c) => {
      const defs = c.workflows.listDefinitions();
      const runs = c.workflows.listRuns(10);
      return text(
        [
          'Workflows:',
          ...(defs.length
            ? defs.map((d) => `  ${d.name}  steps=${d.steps} sessions=${d.sessions.join(',')}`)
            : ['  (none)']),
          '',
          'Recent runs:',
          ...(runs.length
            ? runs.map(
                (r) => `  ${r.runId}  ${r.workflow}  ${r.status}  ${r.durationMs ?? '-'}ms  ${r.startedAt}`,
              )
            : ['  (none)']),
        ].join('\n'),
      );
    },
  }),
  defineTool({
    name: 'workflow_execute',
    title: 'Execute workflow',
    description:
      'Run a saved or inline workflow. Waits for completion unless background=true (then poll workflow_status). Non-idempotent steps (click/submit) are never retried automatically.',
    category: 'workflow',
    profile: 'testing',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 30 * 60_000,
    input: {
      name: z.string().optional(),
      definition: Definition.optional(),
      variables: Vars,
      background: z.boolean().optional(),
      startAt: z.string().optional().describe('Resume from this step id'),
    },
    handler: async (a, c) => {
      const wf = resolveWorkflow(a, c);
      const { runId, promise } = c.workflows.start(wf, {
        ...(a.variables ? { variables: a.variables } : {}),
        ...(a.startAt ? { startAt: a.startAt } : {}),
        signal: c.signal,
      });
      if (a.background) {
        promise.catch(() => undefined);
        return text(`▶ Started ${runId} (${wf.name}). Poll workflow_status runId=${runId}`);
      }
      return text(compactRunSummary(await promise));
    },
  }),
  defineTool({
    name: 'workflow_status',
    title: 'Workflow status',
    description: 'Status of a run (step results, failure diagnostics), or recent runs if no runId.',
    category: 'workflow',
    profile: 'testing',
    risk: 'read',
    readOnly: true,
    timeoutMs: 10_000,
    input: { runId: z.string().optional() },
    handler: async (a, c) => {
      if (!a.runId) return json(c.workflows.listRuns(20));
      return text(compactRunSummary(c.workflows.getRun(a.runId)));
    },
  }),
  defineTool({
    name: 'workflow_cancel',
    title: 'Cancel workflow',
    description: 'Cancel a running workflow.',
    category: 'workflow',
    profile: 'testing',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 10_000,
    input: { runId: z.string() },
    handler: async (a, c) =>
      text(c.workflows.cancel(a.runId) ? `✓ Cancel requested for ${a.runId}` : `${a.runId} is not running`),
  }),
  defineTool({
    name: 'workflow_record_start',
    title: 'Start recording',
    description:
      'Record subsequent browser actions (all or selected sessions) into a workflow. Refs are converted to semantic locators; sensitive values become ${secret.X}.',
    category: 'workflow',
    profile: 'testing',
    risk: 'read',
    readOnly: false,
    timeoutMs: 5_000,
    input: { name: z.string(), sessions: z.array(z.string()).optional() },
    handler: async (a, c) => {
      c.recorder.start(a.name, a.sessions);
      return text(
        `● Recording "${a.name}"${a.sessions?.length ? ` (sessions: ${a.sessions.join(', ')})` : ''}. Call workflow_record_stop when done.`,
      );
    },
  }),
  defineTool({
    name: 'workflow_record_stop',
    title: 'Stop recording',
    description: 'Stop recording and return (and by default save) the workflow definition.',
    category: 'workflow',
    profile: 'testing',
    risk: 'read',
    readOnly: false,
    timeoutMs: 10_000,
    input: { save: z.boolean().default(true) },
    handler: async (a, c) => {
      const wf = assertValidWorkflow(c.recorder.stop());
      const file = a.save ? c.workflows.saveDefinition(wf) : undefined;
      return text(`${file ? `✓ Saved to ${file}\n` : ''}${JSON.stringify(wf, null, 1)}`);
    },
  }),
];

function writeArtifact(c: ToolContext, p: string | undefined, defaultName: string, content: string): string {
  const file = p
    ? c.harness.permissions.checkFilePath(p, 'write')
    : path.join(c.config.dataDir, 'artifacts', c.config.project, 'reports', defaultName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export const testingTools = [
  defineTool({
    name: 'test_assert',
    title: 'Assert',
    description:
      'Web-first assertion with auto-retry until timeout: visible, hidden, text, value, url, title, count, attribute, enabled, disabled, checked, no_console_errors, no_failed_requests.',
    category: 'testing',
    profile: 'testing',
    risk: 'read',
    readOnly: true,
    timeoutMs: 130_000,
    input: { ...AssertionSchema.shape, session: z.string().optional(), pageId: z.string().optional() },
    handler: async (a, c) => {
      const { session, pageId, ...assertion } = a;
      const r = await new AssertionEngine(c.harness.sessions, c.harness.actions).check(assertion, {
        ...(session ? { session } : {}),
        ...(pageId ? { pageId } : {}),
      });
      return {
        content: [{ type: 'text', text: `${r.message} (${r.durationMs}ms)` }],
        ...(r.passed ? {} : { isError: true }),
      };
    },
  }),
  defineTool({
    name: 'test_generate',
    title: 'Generate Playwright test',
    description:
      'Generate a Playwright Test spec (TypeScript) from a workflow — multi-user flows become separate browser contexts with semantic locators.',
    category: 'testing',
    profile: 'testing',
    risk: 'read',
    readOnly: false,
    timeoutMs: 10_000,
    input: {
      name: z.string().optional(),
      definition: Definition.optional(),
      baseUrl: z.string().optional(),
      path: z.string().optional().describe('Write the spec to this file (inside allowed roots)'),
    },
    handler: async (a, c) => {
      const wf = resolveWorkflow(a, c);
      const code = generatePlaywrightTest(wf, a.baseUrl ? { baseUrl: a.baseUrl } : {});
      if (a.path) {
        const f = writeArtifact(c, a.path, '', code);
        return text(
          `✓ Wrote ${f} (${code.split('\n').length} lines). Run: npx playwright test ${path.basename(f)}`,
        );
      }
      return text(code);
    },
  }),
  defineTool({
    name: 'test_execute',
    title: 'Execute test',
    description:
      'Run workflow(s) as tests and produce a report (markdown + JUnit XML) in the artifacts directory.',
    category: 'testing',
    profile: 'testing',
    risk: 'interact',
    readOnly: false,
    timeoutMs: 60 * 60_000,
    input: { names: z.array(z.string()).optional(), definition: Definition.optional(), variables: Vars },
    handler: async (a, c) => {
      const wfs: Workflow[] = [
        ...(a.definition ? [assertValidWorkflow(a.definition)] : []),
        ...(a.names ?? []).map((n) => c.workflows.loadDefinition(n)),
      ];
      if (!wfs.length) throw new TgError('INVALID_ARGUMENT', 'Provide names or definition');
      const runs: RunRecord[] = [];
      for (const wf of wfs)
        runs.push(
          await c.workflows.execute(wf, {
            ...(a.variables ? { variables: a.variables } : {}),
            signal: c.signal,
          }),
        );
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const md = writeArtifact(c, undefined, `report-${stamp}.md`, markdownReport(runs));
      const xml = writeArtifact(c, undefined, `report-${stamp}.xml`, junitReport(runs));
      c.workflows.recordReports(
        runs.map((r) => r.runId),
        [md, xml],
      );
      return {
        content: [
          {
            type: 'text',
            text: `${runs.map(compactRunSummary).join('\n\n')}\n\nReports: ${md}\n         ${xml}`,
          },
        ],
        ...(runs.every((r) => r.status === 'passed') ? {} : { isError: true }),
      };
    },
  }),
  defineTool({
    name: 'test_report',
    title: 'Test report',
    description: 'Build a report for runs (markdown, junit or json). Defaults to the most recent run.',
    category: 'testing',
    profile: 'testing',
    risk: 'read',
    readOnly: false,
    timeoutMs: 10_000,
    input: {
      runIds: z.array(z.string()).optional(),
      format: z.enum(['markdown', 'junit', 'json']).default('markdown'),
      path: z.string().optional(),
    },
    handler: async (a, c) => {
      const ids = a.runIds?.length ? a.runIds : c.workflows.listRuns(1).map((r) => r.runId);
      if (!ids.length) throw new TgError('WORKFLOW_NOT_FOUND', 'No runs found');
      const runs = ids.map((id) => c.workflows.getRun(id));
      const content =
        a.format === 'junit'
          ? junitReport(runs)
          : a.format === 'json'
            ? JSON.stringify(runs, null, 2)
            : markdownReport(runs);
      if (a.path) {
        const file = writeArtifact(c, a.path, '', content);
        c.workflows.recordReports(ids, [file]);
        return text(`✓ Wrote ${file}`);
      }
      return text(content);
    },
  }),
];
