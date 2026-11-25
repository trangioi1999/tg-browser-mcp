import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { generatePlaywrightTest } from '../../src/testing/test-generator.js';
import { WorkflowSchema } from '../../src/workflow/workflow-schema.js';

const payloads = [
  '${process.exit()}',
  "${require('child_process').execSync('id')}",
  '`',
  '\r\n\u2028\u2029',
  "'); evil(); ('",
  '${X}; evil(); //',
  '${secret.PW}; evil(); //',
  '${bad-name}',
  '${X${process.exit()}}',
  '\\`${process.exit()}\\',
];

function nodes(root: ts.Node): ts.Node[] {
  const result: ts.Node[] = [root];
  root.forEachChild((child) => {
    result.push(...nodes(child));
  });
  return result;
}

describe('safe test generation', () => {
  it.each(payloads)('keeps payload %j out of executable syntax', (payload) => {
    const generate = (value: string) =>
      generatePlaywrightTest(
        WorkflowSchema.parse({
          name: value,
          variables: { X: value },
          steps: [
            { id: 'fill', action: 'fill', input: { label: value, value } },
            { id: 'nav', action: 'navigate', input: { url: value } },
            {
              id: 'assert',
              action: 'assert',
              assert: { type: 'text', target: { testId: value }, equals: value },
            },
            { id: 'select', action: 'select', input: { label: value, values: [value] } },
          ],
        }),
      );
    const code = generate(payload);
    const parsed = ts.createSourceFile('generated.ts', code, ts.ScriptTarget.Latest, true);
    const diagnostics = ts.transpileModule(code, { reportDiagnostics: true }).diagnostics;
    expect(diagnostics).toEqual([]);
    // Compare executable structure with a benign value carrying the same valid tokens.
    // Literal contents may differ; calls, operators, identifiers and templates may not.
    const tokens = payload.match(/\$\{(?:secret\.[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*)\}/g) ?? [];
    const baseline = ts.createSourceFile(
      'baseline.ts',
      generate(`safe${tokens.join('safe')}`),
      ts.ScriptTarget.Latest,
      true,
    );
    const structure = (root: ts.Node) =>
      nodes(root).map((node) => (ts.isIdentifier(node) ? [node.kind, node.text] : node.kind));
    expect(structure(parsed)).toEqual(structure(baseline));
    expect(
      nodes(parsed)
        .filter(ts.isIdentifier)
        .some((n) => ['evil', 'require', 'exit', 'execSync'].includes(n.text)),
    ).toBe(false);
  });

  it('emits literal, variable and secret parts as concatenation', () => {
    const code = generatePlaywrightTest(
      WorkflowSchema.parse({
        name: 'parts',
        steps: [
          {
            id: 'fill',
            action: 'fill',
            input: { label: 'Password', value: 'prefix` ${X}/${secret.pw} ${process.exit()}' },
          },
        ],
      }),
    );
    expect(code).toContain('"prefix` " + vars.X + "/" + secret("PW") + " ${process.exit()}"');
  });

  it.each(['bad-name', 'X;evil()', 'x.y', '1x', ''])('rejects invalid variable name %j', (name) => {
    const wf = WorkflowSchema.parse({
      name: 'invalid',
      variables: { [name]: 'x' },
      steps: [{ id: 'a', action: 'snapshot' }],
    });
    expect(() => generatePlaywrightTest(wf)).toThrow('Invalid variable name');
    wf.variables = {};
    wf.steps[0]!.extract = { variable: name, from: 'text' };
    expect(() => generatePlaywrightTest(wf)).toThrow('Invalid variable name');
  });
});
