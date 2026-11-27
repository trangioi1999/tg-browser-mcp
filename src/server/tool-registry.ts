import { z, type ZodRawShape } from 'zod';
import type { TgConfig, ToolProfile } from '../config/schema.js';
import type { BrowserHarness } from '../harness/browser-harness.js';
import type { WorkflowEngine } from '../workflow/workflow-engine.js';
import type { WorkflowRecorder } from '../workflow/workflow-recorder.js';
import type { RiskLevel } from '../security/permission-manager.js';
import type { ActionResult } from '../harness/action-executor.js';
import type { TgError } from '../shared/errors.js';

export type ToolCategory =
  | 'browser'
  | 'navigation'
  | 'interaction'
  | 'inspection'
  | 'tabs'
  | 'debugging'
  | 'session'
  | 'network'
  | 'workflow'
  | 'testing';

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolOutput {
  [key: string]: unknown;
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolContext {
  harness: BrowserHarness;
  workflows: WorkflowEngine;
  recorder: WorkflowRecorder;
  config: TgConfig;
  signal: AbortSignal;
}

/**
 * A strongly typed tool definition. The input shape is a Zod raw shape (validated by the MCP SDK
 * and again here). Output follows the normalized contract described in docs/TOOLS.md:
 * a compact text block (or JSON when output.format=json), optional image content, and
 * isError + normalized error text on failure.
 */
export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  category: ToolCategory;
  /** Lowest profile that includes this tool. */
  profile: ToolProfile;
  risk: RiskLevel;
  readOnly: boolean;
  /** Hard timeout for the whole tool call (ms). */
  timeoutMs: number;
  input: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolOutput>;
}

export function defineTool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

const PROFILE_ORDER: ToolProfile[] = ['minimal', 'developer', 'testing', 'full'];

const CORE_TOOLS = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_select_option',
  'browser_press_key',
  'browser_wait',
  'browser_dialog',
  'browser_tabs',
  'browser_errors',
  'browser_screenshot',
  'session_create',
  'session_switch',
]);

/** Selects the tools advertised for a configuration (profile + explicit enable/disable lists). */
export function selectTools(all: ToolDef[], cfg: TgConfig['tools']): ToolDef[] {
  const level = PROFILE_ORDER.indexOf(cfg.profile);
  const enabled = new Set(cfg.enabled);
  const disabled = new Set(cfg.disabled);
  return all.filter(
    (t) =>
      !disabled.has(t.name) &&
      ((cfg.profile === 'core' ? CORE_TOOLS.has(t.name) : PROFILE_ORDER.indexOf(t.profile) <= level) ||
        enabled.has(t.name)),
  );
}

// ───────────── Output helpers ─────────────

export function text(s: string): ToolOutput {
  return { content: [{ type: 'text', text: s }] };
}

export function json(v: unknown): ToolOutput {
  return text(JSON.stringify(v, null, 1));
}

export function errorOutput(err: TgError): ToolOutput {
  const lines = [`✗ ${err.code}: ${err.message}`, `Retry safe: ${err.retryable ? 'yes' : 'no'}`];
  if (err.suggestion) lines.push(`Suggestion: ${err.suggestion}`);
  const ctx = Object.entries(err.context).filter(([, v]) => v !== undefined);
  if (ctx.length) lines.push(`Context: ${JSON.stringify(Object.fromEntries(ctx))}`);
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
}

export function formatAction(r: ActionResult, format: 'text' | 'json'): ToolOutput {
  if (format === 'json') {
    const { image: _img, ...rest } = r;
    return json(rest);
  }
  const symbol = r.outcome
    ? { VERIFIED: '✓', UNVERIFIED: '•', FAILED: '✗', INDETERMINATE: '?' }[r.outcome.verificationStatus]
    : '✓';
  const lines = [`${symbol} ${r.message} · ${r.durationMs}ms · session=${r.session} page=${r.pageId}`];
  if (r.outcome)
    lines.push(
      `${r.outcome.verificationStatus}: ${r.outcome.failureReason ?? (r.outcome.verificationStatus === 'VERIFIED' ? 'Expectations passed' : 'No expectations supplied')}`,
    );
  for (const field of r.fieldResults ?? [])
    lines.push(
      `Field ${field.index + 1}${field.name ? ` (${field.name})` : ''}: ${field.status}${field.code ? ` [${field.code}]` : ''}${field.reason ? ` (${field.reason})` : ''}`,
    );
  if (r.fieldResults && r.data && typeof r.data === 'object') {
    const report = r.data as { requiredMissing?: string[]; validationMessages?: string[] };
    if (report.requiredMissing?.length) lines.push(`Required missing: ${report.requiredMissing.join(', ')}`);
    if (report.validationMessages?.length) lines.push(`Validation: ${report.validationMessages.join('; ')}`);
  }
  if (r.pageState) lines.push(r.pageState);
  if (r.memory) lines.push(r.memory);
  for (const w of r.warnings) lines.push(`⚠ ${w}`);
  if (r.newPages?.length)
    lines.push(
      `New tabs opened: ${r.newPages.map((p) => `${p.pageId} ${p.url}`).join(', ')} (use browser_tab_switch)`,
    );
  if (r.errors) {
    lines.push('Errors during action:');
    if (r.errors.console) lines.push(r.errors.console);
    if (r.errors.network) lines.push(r.errors.network);
  }
  return text(lines.join('\n'));
}

/** Common optional addressing parameters shared by page-level tools. */
export const PageAddress = {
  session: z.string().optional(),
  pageId: z.string().optional(),
};

export const SnapshotModeParam = {
  snapshot: z
    .enum(['diff', 'full', 'none'])
    .optional()
    .describe('Page state returned after the action: diff (default), full, none'),
};
