import type { RunRecord } from '../workflow/workflow-engine.js';

const ICON: Record<string, string> = {
  passed: '✅',
  failed: '❌',
  skipped: '⏭️',
  pending: '…',
  running: '▶',
  cancelled: '⏹️',
};

export function markdownReport(runs: RunRecord[]): string {
  const out: string[] = ['# TG Browser test report', ''];
  const passed = runs.filter((r) => r.status === 'passed').length;
  out.push(`**${passed}/${runs.length} runs passed** — generated ${new Date().toISOString()}`, '');
  for (const r of runs) {
    out.push(`## ${ICON[r.status] ?? ''} ${r.workflow} (${r.runId})`, '');
    out.push(`Status: **${r.status}** · Duration: ${r.durationMs ?? 0} ms · Started: ${r.startedAt}`, '');
    out.push(
      '| Step | Session | Action | Status | Attempts | ms | Detail |',
      '|---|---|---|---|---|---|---|',
    );
    for (const s of r.steps) {
      const detail = (s.error ? `${s.error.code}: ${s.error.message}` : s.message)
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ')
        .slice(0, 160);
      out.push(
        `| ${s.id} | ${s.session} | ${s.action} | ${ICON[s.status] ?? ''} ${s.status} | ${s.attempts} | ${s.durationMs} | ${detail} |`,
      );
    }
    if (r.failure) {
      out.push(
        '',
        '### Failure diagnostics',
        '',
        `- Step: \`${r.failure.stepId}\``,
        `- Code: \`${r.failure.code}\``,
        `- Message: ${r.failure.message}`,
      );
      if (r.failure.url) out.push(`- URL: ${r.failure.url}`);
      if (r.failure.screenshot) out.push(`- Screenshot: \`${r.failure.screenshot}\``);
      if (r.failure.console) out.push('', '```text', r.failure.console, '```');
      if (r.failure.network) out.push('', '```text', r.failure.network, '```');
    }
    const vars = Object.entries(r.variables);
    if (vars.length) out.push('', `Variables: ${vars.map(([k, v]) => `\`${k}=${v}\``).join(', ')}`);
    out.push('');
  }
  return out.join('\n');
}

const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

export function junitReport(runs: RunRecord[]): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites name="tg-browser">'];
  for (const r of runs) {
    const failures = r.steps.filter((s) => s.status === 'failed').length;
    const skipped = r.steps.filter((s) => s.status === 'skipped' || s.status === 'cancelled').length;
    out.push(
      `  <testsuite name="${xml(r.workflow)}" tests="${r.steps.length}" failures="${failures}" skipped="${skipped}" time="${((r.durationMs ?? 0) / 1000).toFixed(3)}" timestamp="${r.startedAt}">`,
    );
    for (const s of r.steps) {
      out.push(
        `    <testcase classname="${xml(r.workflow)}" name="${xml(`${s.id} ${s.action} [${s.session}]`)}" time="${(s.durationMs / 1000).toFixed(3)}">`,
      );
      if (s.status === 'failed')
        out.push(
          `      <failure message="${xml(s.error?.message ?? s.message)}" type="${xml(s.error?.code ?? 'FAILED')}"/>`,
        );
      if (s.status === 'skipped' || s.status === 'cancelled')
        out.push(`      <skipped message="${xml(s.message)}"/>`);
      out.push('    </testcase>');
    }
    out.push('  </testsuite>');
  }
  out.push('</testsuites>', '');
  return out.join('\n');
}

export function compactRunSummary(r: RunRecord): string {
  const lines = [
    `${ICON[r.status] ?? ''} ${r.workflow} ${r.status.toUpperCase()} (${r.runId}, ${r.durationMs ?? 0}ms)`,
  ];
  for (const s of r.steps)
    lines.push(
      `  ${ICON[s.status] ?? ''} ${s.id} [${s.session}] ${s.action}: ${(s.error ? `${s.error.code} ${s.error.message}` : s.message).replace(/\n/g, ' ').slice(0, 140)}`,
    );
  if (r.failure) {
    lines.push(`Failure at ${r.failure.stepId}: ${r.failure.code} ${r.failure.message}`);
    if (r.failure.url) lines.push(`  url: ${r.failure.url}`);
    if (r.failure.screenshot) lines.push(`  screenshot: ${r.failure.screenshot}`);
    if (r.failure.console) lines.push(`  console:\n${r.failure.console.replace(/^/gm, '    ')}`);
    if (r.failure.network) lines.push(`  network:\n${r.failure.network.replace(/^/gm, '    ')}`);
  }
  const vars = Object.entries(r.variables);
  if (vars.length) lines.push(`Variables: ${vars.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return lines.join('\n');
}
