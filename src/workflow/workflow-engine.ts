import fs from 'node:fs';
import path from 'node:path';
import type { BrowserHarness } from '../harness/browser-harness.js';
import type { ActionContext } from '../harness/action-executor.js';
import { AssertionEngine, type AssertionResult } from '../testing/assertion-engine.js';
import { TgError, toTgError, type SerializedError } from '../shared/errors.js';
import { assertSafeName, shortId, sleep, truncate } from '../shared/util.js';
import { getLogger } from '../shared/logger.js';
import { formatConsole, formatNetwork } from '../network/network-monitor.js';
import { browserShortcut } from '../config/load-config.js';
import { IDEMPOTENT_ACTIONS, type Workflow, type WorkflowStep } from './workflow-schema.js';
import { assertValidWorkflow } from './workflow-validator.js';
import type { Target } from '../harness/target.js';

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'running';

export interface StepResult {
  id: string;
  name?: string;
  action: string;
  session: string;
  status: StepStatus;
  attempts: number;
  durationMs: number;
  message: string;
  error?: SerializedError;
  assertion?: AssertionResult;
  extracted?: { variable: string; value: string };
}

export interface RunRecord {
  runId: string;
  workflow: string;
  project: string;
  status: 'running' | 'passed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  steps: StepResult[];
  variables: Record<string, string>;
  failure?: {
    stepId: string;
    code: string;
    message: string;
    url?: string;
    screenshot?: string;
    console?: string;
    network?: string;
  };
}

export interface ExecuteOptions {
  variables?: Record<string, string | number | boolean>;
  /** Skip steps before this id (resume from a checkpoint; sessions must already be in the right state). */
  startAt?: string;
  signal?: AbortSignal;
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;

/**
 * Executes declarative multi-session workflows (e.g. maker → checker → maker). Each step runs
 * in a named session (isolated browser context). Supports shared variables, extraction,
 * dependencies, conditions, idempotency-aware retries, assertions, failure diagnostics
 * (screenshot + console + network), checkpoints and cancellation.
 */
export class WorkflowEngine {
  private readonly runs = new Map<
    string,
    { record: RunRecord; controller: AbortController; promise: Promise<RunRecord> }
  >();
  private readonly assertions: AssertionEngine;

  constructor(private readonly h: BrowserHarness) {
    this.assertions = new AssertionEngine(h.sessions, h.actions);
  }

  get runsDir(): string {
    return path.join(this.h.config.dataDir, 'runs', this.h.config.project);
  }

  get workflowsDir(): string {
    return path.join(this.h.config.dataDir, 'workflows', this.h.config.project);
  }

  // ───────────── Storage ─────────────

  saveDefinition(wf: Workflow): string {
    fs.mkdirSync(this.workflowsDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.workflowsDir, `${assertSafeName('workflow', slug(wf.name))}.json`);
    fs.writeFileSync(file, `${JSON.stringify(wf, null, 2)}\n`, { mode: 0o600 });
    return file;
  }

  loadDefinition(name: string): Workflow {
    const file = path.join(this.workflowsDir, `${assertSafeName('workflow', slug(name))}.json`);
    if (!fs.existsSync(file))
      throw new TgError('WORKFLOW_NOT_FOUND', `Workflow "${name}" not found`, {
        suggestion: 'Call workflow_list.',
      });
    return assertValidWorkflow(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  listDefinitions(): Array<{ name: string; steps: number; sessions: string[]; file: string }> {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.workflowsDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files.flatMap((f) => {
      try {
        const wf = JSON.parse(fs.readFileSync(path.join(this.workflowsDir, f), 'utf8')) as Workflow;
        return [
          {
            name: wf.name,
            steps: wf.steps.length,
            sessions: [...new Set(wf.steps.map((s) => s.session ?? 'default'))],
            file: path.join(this.workflowsDir, f),
          },
        ];
      } catch {
        return [];
      }
    });
  }

  private checkpoint(r: RunRecord): void {
    try {
      fs.mkdirSync(this.runsDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(this.runsDir, `${r.runId}.json`), JSON.stringify(r, null, 2), {
        mode: 0o600,
      });
    } catch (e) {
      getLogger().warn({ err: (e as Error).message }, 'failed to write workflow checkpoint');
    }
  }

  getRun(runId: string): RunRecord {
    const live = this.runs.get(runId);
    if (live) return live.record;
    const f = path.join(this.runsDir, `${assertSafeName('run', runId)}.json`);
    if (!fs.existsSync(f)) throw new TgError('WORKFLOW_NOT_FOUND', `Run ${runId} not found`);
    return JSON.parse(fs.readFileSync(f, 'utf8')) as RunRecord;
  }

  listRuns(limit = 20): Array<Pick<RunRecord, 'runId' | 'workflow' | 'status' | 'startedAt' | 'durationMs'>> {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.runsDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.runsDir, f), 'utf8')) as RunRecord)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map(({ runId, workflow, status, startedAt, durationMs }) => ({
        runId,
        workflow,
        status,
        startedAt,
        ...(durationMs !== undefined ? { durationMs } : {}),
      }));
  }

  cancel(runId: string): boolean {
    const r = this.runs.get(runId);
    if (!r || r.record.status !== 'running') return false;
    r.controller.abort(new TgError('WORKFLOW_FAILED', 'Workflow cancelled'));
    return true;
  }

  // ───────────── Execution ─────────────

  /** Starts a run and returns immediately with its id; await `wait(runId)` for the result. */
  start(input: unknown, opts: ExecuteOptions = {}): { runId: string; promise: Promise<RunRecord> } {
    const wf = assertValidWorkflow(input, Object.keys(opts.variables ?? {}));
    const controller = new AbortController();
    if (opts.signal)
      opts.signal.addEventListener('abort', () => controller.abort(opts.signal!.reason), { once: true });
    const record: RunRecord = {
      runId: shortId('run'),
      workflow: wf.name,
      project: this.h.config.project,
      status: 'running',
      startedAt: new Date().toISOString(),
      steps: wf.steps.map((s) => ({
        id: s.id,
        ...(s.name ? { name: s.name } : {}),
        action: s.action,
        session: s.session,
        status: 'pending' as const,
        attempts: 0,
        durationMs: 0,
        message: '',
      })),
      variables: {},
    };
    const promise = this.runInternal(wf, record, opts, controller.signal).finally(() => {
      setTimeout(() => this.runs.delete(record.runId), 10 * 60_000).unref?.();
    });
    this.runs.set(record.runId, { record, controller, promise });
    return { runId: record.runId, promise };
  }

  async execute(input: unknown, opts: ExecuteOptions = {}): Promise<RunRecord> {
    return this.start(input, opts).promise;
  }

  private async runInternal(
    wf: Workflow,
    record: RunRecord,
    opts: ExecuteOptions,
    signal: AbortSignal,
  ): Promise<RunRecord> {
    const t0 = Date.now();
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...wf.variables, ...(opts.variables ?? {}) })) vars[k] = String(v);
    const secretValues = new Set<string>();
    this.h.events.emit('workflow.started', { runId: record.runId, workflow: wf.name });
    let started = !opts.startAt;
    try {
      await this.ensureSessions(wf);
      for (const [i, step] of wf.steps.entries()) {
        const sr = record.steps[i]!;
        if (signal.aborted) throw signal.reason;
        if (!started) {
          if (step.id === opts.startAt) started = true;
          else {
            sr.status = 'skipped';
            sr.message = 'before startAt';
            continue;
          }
        }
        const failedDep = step.dependsOn.find(
          (d) => record.steps.find((s) => s.id === d)?.status !== 'passed',
        );
        if (failedDep) {
          sr.status = 'skipped';
          sr.message = `dependency ${failedDep} did not pass`;
          this.h.events.emit('workflow.step', { runId: record.runId, stepId: step.id, status: 'skipped' });
          continue;
        }
        if (step.when && !evalCondition(step.when, vars)) {
          sr.status = 'skipped';
          sr.message = `condition false: ${step.when}`;
          this.h.events.emit('workflow.step', { runId: record.runId, stepId: step.id, status: 'skipped' });
          continue;
        }
        sr.status = 'running';
        const st = Date.now();
        const retryable = IDEMPOTENT_ACTIONS.has(step.action) || step.idempotent === true;
        const maxAttempts = 1 + (retryable ? (step.retry?.attempts ?? 0) : 0);
        let lastErr: TgError | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          sr.attempts = attempt;
          try {
            const input = interpolate(step.input, vars, secretValues) as Record<string, unknown>;
            const out = await withTimeout(
              this.runStep(step, input, vars, secretValues, signal),
              step.timeout ?? wf.defaults.timeout ?? this.h.config.browser.timeout * 2,
              signal,
            );
            Object.assign(sr, out);
            sr.status = 'passed';
            lastErr = undefined;
            break;
          } catch (e) {
            lastErr = toTgError(e, 'WORKFLOW_FAILED');
            if (signal.aborted) break;
            if (attempt < maxAttempts && lastErr.retryable)
              await sleep(step.retry?.delayMs ?? 500, signal).catch(() => undefined);
            else break;
          }
        }
        sr.durationMs = Date.now() - st;
        if (lastErr) {
          sr.status = 'failed';
          sr.error = lastErr.toJSON();
          sr.message = lastErr.message;
          this.h.events.emit('workflow.step', { runId: record.runId, stepId: step.id, status: 'failed' });
          if (signal.aborted) throw signal.reason;
          if (!step.continueOnError) {
            record.failure = await this.diagnoseFailure(step, lastErr, record.runId);
            record.status = 'failed';
            break;
          }
        } else
          this.h.events.emit('workflow.step', { runId: record.runId, stepId: step.id, status: 'passed' });
        record.variables = redactVars(vars, secretValues);
        this.checkpoint(record);
      }
      if (record.status === 'running')
        record.status = record.steps.some((s) => s.status === 'failed') ? 'failed' : 'passed';
    } catch (e) {
      const err = toTgError(e, 'WORKFLOW_FAILED');
      record.status = signal.aborted ? 'cancelled' : 'failed';
      for (const s of record.steps)
        if (s.status === 'pending' || s.status === 'running') s.status = 'skipped';
      record.failure ??= {
        stepId: record.steps.find((s) => s.status === 'failed')?.id ?? '',
        code: err.code,
        message: err.message,
      };
    }
    record.finishedAt = new Date().toISOString();
    record.durationMs = Date.now() - t0;
    record.variables = redactVars(vars, secretValues);
    this.checkpoint(record);
    if (record.status === 'passed')
      this.h.events.emit('workflow.completed', {
        runId: record.runId,
        workflow: wf.name,
        durationMs: record.durationMs,
      });
    else
      this.h.events.emit('workflow.failed', {
        runId: record.runId,
        workflow: wf.name,
        ...(record.failure?.stepId ? { stepId: record.failure.stepId } : {}),
        code: record.failure?.code ?? 'WORKFLOW_FAILED',
        message: record.failure?.message ?? record.status,
      });
    return record;
  }

  private async ensureSessions(wf: Workflow): Promise<void> {
    const names = [...new Set(wf.steps.map((s) => s.session))];
    for (const name of names) {
      if (this.h.sessions.find(name)) continue;
      const decl = wf.sessions[name] ?? {};
      await this.h.sessions.create({
        name,
        ...(decl.persistent !== undefined ? { persistent: decl.persistent } : {}),
        ...(decl.restore ? { restore: true } : {}),
        ...(decl.browser ? { browser: browserShortcut(decl.browser) } : {}),
      });
    }
  }

  private async runStep(
    step: WorkflowStep,
    input: Record<string, unknown>,
    vars: Record<string, string>,
    secrets: Set<string>,
    signal: AbortSignal,
  ): Promise<Partial<StepResult>> {
    const a = this.h.actions;
    const ctx: ActionContext = {
      session: step.session,
      snapshot: 'none',
      ...(typeof input.pageId === 'string' ? { pageId: input.pageId } : {}),
    };
    const target = pickTarget(input);
    const msg = (m: string) => ({ message: secrets.size ? maskSecrets(m, secrets) : m });
    switch (step.action) {
      case 'navigate':
        return msg((await a.navigate(String(input.url), ctx)).message);
      case 'click':
      case 'double_click':
        return msg((await a.click(target, { doubleClick: step.action === 'double_click' }, ctx)).message);
      case 'fill':
        return msg((await a.fill(target, String(input.value), { submit: !!input.submit }, ctx)).message);
      case 'fill_form': {
        const fields = (input.fields as Array<Record<string, unknown>>).map((f) => ({
          target: pickTarget(f),
          value: typeof f.value === 'boolean' ? f.value : String(f.value),
        }));
        return msg((await a.fillForm(fields, ctx)).message);
      }
      case 'type':
        return msg(
          (
            await a.type(
              hasAny(input) ? target : undefined,
              String(input.text),
              { submit: !!input.submit },
              ctx,
            )
          ).message,
        );
      case 'press':
        return msg((await a.press(String(input.key), hasAny(input) ? target : undefined, ctx)).message);
      case 'select':
        return msg(
          (await a.selectOption(target, ([] as unknown[]).concat(input.values).map(String), ctx)).message,
        );
      case 'check':
      case 'uncheck':
        return msg((await a.setChecked(target, step.action === 'check', ctx)).message);
      case 'hover':
        return msg((await a.hover(target, ctx)).message);
      case 'wait':
        return msg(
          (
            await a.wait(
              { ...(input as object), ...(hasAny(input) ? { target } : {}) } as Parameters<typeof a.wait>[0],
              ctx,
            )
          ).message,
        );
      case 'dialog':
        return msg((await a.dialog(!!input.accept, input.promptText as string | undefined, ctx)).message);
      case 'screenshot': {
        const r = await a.screenshot({ save: true, fullPage: !!input.fullPage }, ctx);
        return { message: `Screenshot saved ${r.path}` };
      }
      case 'snapshot': {
        const r = await a.snapshot({}, ctx);
        return { message: truncate(r.text, 2000) };
      }
      case 'save_session': {
        const r = await this.h.sessions.save(step.session);
        return { message: `Saved session ${r.name} (${r.cookies} cookies)` };
      }
      case 'new_tab':
        return msg((await a.tabCreate(input.url ? String(input.url) : undefined, ctx)).message);
      case 'switch_tab':
        return msg((await a.tabSwitch(String(input.pageId), { ...ctx, snapshot: 'none' })).message);
      case 'assert': {
        const assertion = interpolate(step.assert, vars, secrets) as NonNullable<WorkflowStep['assert']>;
        const res = await this.assertions.check(assertion, ctx, signal);
        if (!res.passed)
          throw new TgError('ASSERTION_FAILED', res.message, {
            context: { expected: res.expected, actual: res.actual },
          });
        return { message: res.message, assertion: res };
      }
      case 'extract': {
        const ex = interpolate(step.extract, vars, secrets) as NonNullable<WorkflowStep['extract']>;
        let raw: string;
        const t = ex.target as Target | undefined;
        if (ex.from === 'url') raw = (await a.pageInfo(ctx)).url;
        else if (ex.from === 'title') raw = (await a.pageInfo(ctx)).title;
        else if (ex.from === 'attribute')
          raw =
            (await a.getAttributes(t!, ex.attribute ? [ex.attribute] : undefined, ctx))[ex.attribute ?? ''] ??
            '';
        else if (ex.from === 'value') raw = await a.inputValue(t!, ctx);
        else raw = await a.getText(t, { maxChars: 10_000 }, ctx);
        let value = raw.trim();
        if (ex.pattern) {
          const m = new RegExp(ex.pattern).exec(raw);
          if (!m)
            throw new TgError('WORKFLOW_FAILED', `extract: pattern /${ex.pattern}/ did not match`, {
              retryable: true,
              context: { sample: truncate(raw, 200) },
            });
          value = (m[1] ?? m[0]).trim();
        }
        vars[ex.variable] = value;
        return {
          message: `Extracted ${ex.variable}=${truncate(value, 80)}`,
          extracted: { variable: ex.variable, value },
        };
      }
    }
  }

  private async diagnoseFailure(
    step: WorkflowStep,
    err: TgError,
    runId: string,
  ): Promise<RunRecord['failure']> {
    const f: NonNullable<RunRecord['failure']> = { stepId: step.id, code: err.code, message: err.message };
    try {
      const s = this.h.sessions.get(step.session);
      const ps = s.page();
      f.url = this.h.redactor.url(ps.page.url());
      const dir = path.join(this.h.config.dataDir, 'artifacts', 'runs', runId);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `failure-${step.id}.png`);
      await ps.page.screenshot({ path: file, timeout: 5000 });
      f.screenshot = file;
      const errs = s.monitor.errors(ps.id);
      if (errs.console.length) f.console = formatConsole(errs.console.slice(-5));
      if (errs.network.length) f.network = formatNetwork(errs.network.slice(-5));
    } catch {
      // diagnostics are best-effort
    }
    return f;
  }
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'workflow'
  );
}

const TARGET_KEYS = [
  'ref',
  'role',
  'name',
  'exact',
  'label',
  'testId',
  'placeholder',
  'text',
  'selector',
  'nth',
] as const;

function pickTarget(input: Record<string, unknown>): Target {
  const t: Record<string, unknown> = {};
  for (const k of TARGET_KEYS) if (input[k] !== undefined) t[k] = input[k];
  // `name` is an accessible name only together with role.
  if (!t.role) delete t.name;
  return t as Target;
}

function hasAny(input: Record<string, unknown>): boolean {
  return (
    ['ref', 'role', 'label', 'testId', 'placeholder', 'selector'].some((k) => input[k] !== undefined) ||
    (input.text !== undefined && input.key !== undefined)
  );
}

/** Resolves ${var} and ${secret.NAME} (from env TG_SECRET_NAME). Secret values are tracked for masking. */
export function interpolate(v: unknown, vars: Record<string, string>, secrets: Set<string>): unknown {
  if (typeof v === 'string') {
    return v.replace(VAR_RE, (_m, name: string) => {
      if (name.startsWith('secret.')) {
        const envName = `TG_SECRET_${name.slice(7).toUpperCase()}`;
        const val = process.env[envName];
        if (val === undefined)
          throw new TgError('WORKFLOW_FAILED', `Secret ${name} is not set (env ${envName})`);
        secrets.add(val);
        return val;
      }
      const val = vars[name];
      if (val === undefined) throw new TgError('WORKFLOW_FAILED', `Variable \${${name}} is not defined`);
      return val;
    });
  }
  if (Array.isArray(v)) return v.map((x) => interpolate(x, vars, secrets));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x, vars, secrets)]));
  return v;
}

/** Tiny, safe condition language (no eval): "${a}", "!${a}", "${a} == 'x'", "${a} != 'x'". */
export function evalCondition(expr: string, vars: Record<string, string>): boolean {
  const resolve = (s: string): string => {
    const t = s.trim();
    const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(t);
    if (m) return vars[m[1]!] ?? '';
    const q = /^(['"])(.*)\1$/.exec(t);
    if (q) return q[2]!;
    return t;
  };
  const cmp = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(expr.trim());
  if (cmp) {
    const l = resolve(cmp[1]!);
    const r = resolve(cmp[3]!);
    return cmp[2] === '==' ? l === r : l !== r;
  }
  const neg = expr.trim().startsWith('!');
  const val = resolve(neg ? expr.trim().slice(1) : expr);
  const truthy = val !== '' && val !== 'false' && val !== '0';
  return neg ? !truthy : truthy;
}

function maskSecrets(s: string, secrets: Set<string>): string {
  let out = s;
  for (const v of secrets) if (v) out = out.split(v).join('[secret]');
  return out;
}

function redactVars(vars: Record<string, string>, secrets: Set<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, secrets.has(v) ? '[secret]' : v]));
}

async function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  p.catch(() => undefined);
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TgError('ACTION_TIMEOUT', `Step exceeded ${ms}ms`, { retryable: true })),
          ms,
        );
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
