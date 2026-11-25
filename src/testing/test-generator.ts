import type { Workflow, WorkflowStep } from '../workflow/workflow-schema.js';
import type { Target } from '../harness/target.js';

const q = (s: unknown) =>
  JSON.stringify(String(s))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertVariableName(name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid variable name: ${q(name)}`);
}

type ValuePart = { kind: 'literal'; value: string } | { kind: 'var' | 'secret'; name: string };

/** Only recognized workflow tokens become code; all other text stays a string literal. */
function tpl(s: unknown): string {
  const str = String(s);
  const parts: ValuePart[] = [];
  let offset = 0;
  for (const match of str.matchAll(/\$\{(secret\.([A-Za-z0-9_]+)|[A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    parts.push({ kind: 'literal', value: str.slice(offset, match.index) });
    parts.push(
      match[2] ? { kind: 'secret', name: match[2].toUpperCase() } : { kind: 'var', name: match[1]! },
    );
    offset = match.index + match[0].length;
  }
  parts.push({ kind: 'literal', value: str.slice(offset) });
  return parts
    .map((part) => {
      if (part.kind === 'literal') return q(part.value);
      if (part.kind === 'secret') return `secret(${q(part.name)})`;
      assertVariableName(part.name);
      return `vars.${part.name}`;
    })
    .join(' + ');
}

function locatorExpr(page: string, t: Partial<Target>): string {
  if (t.role)
    return `${page}.getByRole(${q(t.role)}${t.name !== undefined ? `, { name: ${tpl(t.name)}, exact: ${t.exact !== false} }` : ''})`;
  if (t.label) return `${page}.getByLabel(${tpl(t.label)})`;
  if (t.testId) return `${page}.getByTestId(${tpl(t.testId)})`;
  if (t.placeholder) return `${page}.getByPlaceholder(${tpl(t.placeholder)})`;
  if (t.text) return `${page}.getByText(${tpl(t.text)}${t.exact ? ', { exact: true }' : ''})`;
  if (t.selector) return `${page}.locator(${tpl(t.selector)})`;
  return `${page}.locator('body')`;
}

function targetOf(input: Record<string, unknown>, action: string): Partial<Target> {
  const t: Partial<Target> = {};
  for (const k of ['role', 'name', 'exact', 'label', 'testId', 'placeholder', 'selector'] as const)
    if (input[k] !== undefined) (t as Record<string, unknown>)[k] = input[k];
  if (input.text !== undefined && action !== 'type') t.text = String(input.text);
  return t;
}

function stepCode(s: WorkflowStep, page: string, ind: string): string[] {
  const i = s.input;
  const loc = () => locatorExpr(page, targetOf(i, s.action));
  const lines: string[] = [];
  switch (s.action) {
    case 'navigate':
      lines.push(`await ${page}.goto(${tpl(i.url)});`);
      break;
    case 'click':
      lines.push(`await ${loc()}.click();`);
      break;
    case 'double_click':
      lines.push(`await ${loc()}.dblclick();`);
      break;
    case 'fill':
      lines.push(`await ${loc()}.fill(${tpl(i.value)});`);
      if (i.submit) lines.push(`await ${loc()}.press('Enter');`);
      break;
    case 'fill_form':
      for (const f of (i.fields as Array<Record<string, unknown>>) ?? []) {
        const l = locatorExpr(page, targetOf(f, 'fill'));
        lines.push(
          typeof f.value === 'boolean'
            ? `await ${l}.setChecked(${f.value});`
            : `await fillField(${page}, ${l}, ${tpl(f.value)});`,
        );
      }
      break;
    case 'type':
      lines.push(
        Object.keys(targetOf(i, 'type')).length
          ? `await ${loc()}.pressSequentially(${tpl(i.text)});`
          : `await ${page}.keyboard.type(${tpl(i.text)});`,
      );
      break;
    case 'press':
      lines.push(
        Object.keys(targetOf(i, 'press')).length
          ? `await ${loc()}.press(${q(i.key)});`
          : `await ${page}.keyboard.press(${q(i.key)});`,
      );
      break;
    case 'select': {
      const vals = ([] as unknown[]).concat(i.values);
      lines.push(`await selectOption(${page}, ${loc()}, [${vals.map(tpl).join(', ')}]);`);
      break;
    }
    case 'check':
      lines.push(`await ${loc()}.check();`);
      break;
    case 'uncheck':
      lines.push(`await ${loc()}.uncheck();`);
      break;
    case 'hover':
      lines.push(`await ${loc()}.hover();`);
      break;
    case 'wait':
      if (i.text) lines.push(`await expect(${page}.getByText(${tpl(i.text)}).first()).toBeVisible();`);
      else if (i.textGone)
        lines.push(`await expect(${page}.getByText(${tpl(i.textGone)}).first()).toBeHidden();`);
      else if (i.url) lines.push(`await ${page}.waitForURL(${tpl(i.url)});`);
      else if (i.loadState) lines.push(`await ${page}.waitForLoadState(${q(i.loadState)});`);
      else if (Object.keys(targetOf(i, 'wait')).length)
        lines.push(`await expect(${loc()}).toBe${i.state === 'hidden' ? 'Hidden' : 'Visible'}();`);
      else if (i.timeMs) lines.push(`await ${page}.waitForTimeout(${Number(i.timeMs)});`);
      break;
    case 'dialog':
      lines.push(
        `// Dialog handling: registered before the triggering action in real tests`,
        `${page}.once('dialog', (d) => d.${i.accept ? 'accept' : 'dismiss'}());`,
      );
      break;
    case 'screenshot':
      lines.push(`await ${page}.screenshot({ path: test.info().outputPath(${q(`${s.id}.png`)}) });`);
      break;
    case 'snapshot':
      lines.push(`await expect(${page}.locator('body')).toBeVisible();`);
      break;
    case 'save_session':
      lines.push(
        `await ${page}.context().storageState({ path: test.info().outputPath(${q(`${s.session}.json`)}) });`,
      );
      break;
    case 'new_tab':
      lines.push(`${page} = await ${page}.context().newPage();`);
      if (i.url) lines.push(`await ${page}.goto(${tpl(i.url)});`);
      break;
    case 'switch_tab':
      lines.push(`// switch_tab ${q(i.pageId)}: select the page explicitly in generated tests`);
      break;
    case 'extract': {
      const ex = s.extract!;
      const src =
        ex.from === 'url'
          ? `${page}.url()`
          : ex.from === 'title'
            ? `await ${page}.title()`
            : ex.from === 'attribute'
              ? `(await ${locatorExpr(page, ex.target ?? {})}.getAttribute(${q(ex.attribute)})) ?? ''`
              : ex.from === 'value'
                ? `await ${locatorExpr(page, ex.target ?? {})}.inputValue()`
                : ex.target
                  ? `await ${locatorExpr(page, ex.target)}.innerText()`
                  : `await ${page}.locator('body').innerText()`;
      lines.push(`{`, `${ind}  const raw = ${src};`);
      if (ex.pattern)
        lines.push(
          `${ind}  const m = new RegExp(${q(ex.pattern)}).exec(raw);`,
          `${ind}  expect(m, 'extract ${ex.variable}').not.toBeNull();`,
          `${ind}  vars.${ex.variable} = (m![1] ?? m![0]).trim();`,
        );
      else lines.push(`${ind}  vars.${ex.variable} = raw.trim();`);
      lines.push(`}`);
      break;
    }
    case 'assert': {
      const a = s.assert!;
      const l = locatorExpr(page, a.target ?? {});
      const exp =
        a.equals !== undefined
          ? tpl(a.equals)
          : a.contains !== undefined
            ? tpl(a.contains)
            : a.matches !== undefined
              ? `new RegExp(${q(a.matches)})`
              : undefined;
      switch (a.type) {
        case 'visible':
          lines.push(`await expect(${l}).toBeVisible();`);
          break;
        case 'hidden':
          lines.push(`await expect(${l}).toBeHidden();`);
          break;
        case 'text':
          lines.push(
            a.target
              ? `await expect(${l}).${a.equals !== undefined ? 'toHaveText' : 'toContainText'}(${exp ?? "''"});`
              : `await expect(${page}.locator('body')).toContainText(${exp ?? "''"});`,
          );
          break;
        case 'value':
          lines.push(`await expect(${l}).toHaveValue(${exp ?? "''"});`);
          break;
        case 'url':
          lines.push(
            a.equals !== undefined
              ? `await expect(${page}).toHaveURL(${exp});`
              : a.matches !== undefined
                ? `await expect(${page}).toHaveURL(${exp});`
                : `await expect.poll(() => ${page}.url()).toContain(${exp ?? "''"});`,
          );
          break;
        case 'title':
          lines.push(`await expect(${page}).toHaveTitle(${exp ?? "''"});`);
          break;
        case 'count':
          lines.push(`await expect(${l}).toHaveCount(${Number(a.equals ?? 1)});`);
          break;
        case 'attribute':
          lines.push(`await expect(${l}).toHaveAttribute(${q(a.attribute)}, ${exp ?? "''"});`);
          break;
        case 'enabled':
          lines.push(`await expect(${l}).toBeEnabled();`);
          break;
        case 'disabled':
          lines.push(`await expect(${l}).toBeDisabled();`);
          break;
        case 'checked':
          lines.push(`await expect(${l}).toBeChecked();`);
          break;
        case 'no_console_errors':
          lines.push(`expect(consoleErrors.get(${q(s.session)}) ?? []).toEqual([]);`);
          break;
        case 'no_failed_requests':
          lines.push(`expect(failedRequests.get(${q(s.session)}) ?? []).toEqual([]);`);
          break;
      }
      break;
    }
  }
  return lines;
}

/**
 * Generates a self-contained Playwright Test spec from a workflow. Each workflow session becomes
 * an isolated BrowserContext; semantic locators are used throughout; secrets are read from env.
 */
export function generatePlaywrightTest(wf: Workflow, opts: { baseUrl?: string } = {}): string {
  for (const name of Object.keys(wf.variables)) assertVariableName(name);
  for (const step of wf.steps) {
    if (step.extract) assertVariableName(step.extract.variable);
  }
  const sessions = [...new Set(wf.steps.map((s) => s.session))];
  const pageVar = (s: string) => `${s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1')}Page`;
  const vars = { ...wf.variables, ...(opts.baseUrl ? { BASE_URL: opts.baseUrl } : {}) };
  const usesSecrets = wf.steps.some((s) => JSON.stringify(s).includes('${secret.'));
  const out: string[] = [];
  out.push(`// Generated by TG Browser MCP from workflow ${q(wf.name)}. Review before committing.`);
  out.push(`import { test, expect, type Page, type Locator } from '@playwright/test';`, '');
  out.push(`const vars: Record<string, string> = {`);
  for (const [k, v] of Object.entries(vars)) out.push(`  ${k}: process.env.${k} ?? ${q(v)},`);
  out.push(`};`, '');
  if (usesSecrets) {
    out.push(
      `function secret(name: string): string {`,
      `  const v = process.env[\`TG_SECRET_\${name}\`];`,
      `  if (!v) throw new Error(\`Set env TG_SECRET_\${name}\`);`,
      `  return v;`,
      `}`,
      '',
    );
  }
  const usesFillForm = wf.steps.some((s) => s.action === 'fill_form');
  if (wf.steps.some((s) => s.action === 'select') || usesFillForm) {
    out.push(
      `/** Native <select> or ARIA combobox (Angular Material, PrimeNG). */`,
      `async function selectOption(page: Page, el: Locator, values: string[]) {`,
      `  if ((await el.evaluate((e) => e.tagName)) === 'SELECT') { await el.selectOption(values.map((label) => ({ label }))); return; }`,
      `  for (const v of values) { await el.click(); await page.getByRole('option', { name: v, exact: true }).click(); }`,
      `}`,
      '',
    );
  }
  if (usesFillForm) {
    out.push(
      `/** Fills a text field, or selects in a native/ARIA select, like TG Browser's fill_form. */`,
      `async function fillField(page: Page, el: Locator, value: string) {`,
      `  const kind = await el.evaluate((e) => e.tagName === 'SELECT' ? 'select' : e.getAttribute('role') === 'combobox' && !(e instanceof HTMLInputElement) ? 'combobox' : 'text');`,
      `  if (kind === 'text') await el.fill(value);`,
      `  else await selectOption(page, el, [value]);`,
      `}`,
      '',
    );
  }
  out.push(`test(${q(wf.name)}, async ({ browser }) => {`);
  out.push(
    `  const consoleErrors = new Map<string, string[]>();`,
    `  const failedRequests = new Map<string, string[]>();`,
  );
  for (const s of sessions) {
    const pv = pageVar(s);
    out.push(`  const ${s.replace(/[^A-Za-z0-9_]/g, '_')}Context = await browser.newContext();`);
    out.push(`  let ${pv} = await ${s.replace(/[^A-Za-z0-9_]/g, '_')}Context.newPage();`);
    out.push(
      `  ${pv}.on('console', (m) => { if (m.type() === 'error') consoleErrors.set(${q(s)}, [...(consoleErrors.get(${q(s)}) ?? []), m.text()]); });`,
    );
    out.push(
      `  ${pv}.on('response', (r) => { if (r.status() >= 400) failedRequests.set(${q(s)}, [...(failedRequests.get(${q(s)}) ?? []), \`\${r.status()} \${r.url()}\`]); });`,
    );
  }
  out.push('');
  for (const s of wf.steps) {
    const title = `${s.id}${s.name ? `: ${s.name}` : ''} [${s.session}] ${s.action}`;
    const code = stepCode(s, pageVar(s.session), '    ');
    const cond = s.when ? conditionExpr(s.when) : undefined;
    out.push(`  await test.step(${q(title)}, async () => {`);
    if (cond) out.push(`    if (!(${cond})) return;`);
    for (const l of code) out.push(`    ${l}`);
    out.push(`  });`);
  }
  out.push('');
  for (const s of sessions) out.push(`  await ${s.replace(/[^A-Za-z0-9_]/g, '_')}Context.close();`);
  out.push(`});`, '');
  return out.join('\n');
}

function conditionExpr(when: string): string {
  const v = (x: string) => {
    const t = x.trim();
    const m = /^\$\{([A-Za-z_]\w*)\}$/.exec(t);
    return m ? `(vars.${m[1]} ?? '')` : q(t.replace(/^(['"])(.*)\1$/, '$2'));
  };
  const c = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(when.trim());
  if (c) return `${v(c[1]!)} ${c[2] === '==' ? '===' : '!=='} ${v(c[3]!)}`;
  const neg = when.trim().startsWith('!');
  const e = v(neg ? when.trim().slice(1) : when);
  return neg ? `!${e}` : `!!${e}`;
}
