import type { Request, Response } from 'playwright';
import type { Session, PageState } from '../session/session.js';
import type { AssertionEngine } from '../testing/assertion-engine.js';
import type { DataRedactor } from '../security/data-redactor.js';
import { resolveTarget } from './target.js';
import { currentScope } from './call-scope.js';
import { sleep } from '../shared/util.js';
import type { ActionOutcome, ExpectSpec } from './action-outcome.js';
import type { ActionResult } from './action-pipeline.js';

export interface VerificationSignals {
  network?: boolean;
  validation?: boolean;
  alerts?: boolean;
}

/** A per-action observer. Raw response bodies never enter monitor buffers, events or results. */
export class ActionVerifier {
  private readonly requests = new Set<Request>();
  private readonly responses: Response[] = [];
  private readonly onRequest = (request: Request) => {
    if (this.requests.size < 500) this.requests.add(request);
  };
  private readonly onResponse = (response: Response) => {
    if (this.requests.has(response.request()) && this.responses.length < 500) this.responses.push(response);
  };
  private readonly initialUrl: string;
  private readonly initialInvalid: Promise<number>;
  private readonly initialAlerts: Promise<string[]>;
  constructor(
    private readonly s: Session,
    private readonly ps: PageState,
    private readonly seq: number,
    private readonly redactor: DataRedactor,
    private readonly assertions: AssertionEngine,
    private readonly expected: ExpectSpec[] = [],
    private readonly signals: VerificationSignals = {},
  ) {
    this.initialUrl = ps.page.url();
    this.initialInvalid = ps.pendingDialog ? Promise.resolve(Infinity) : this.invalidCount();
    this.initialAlerts = ps.pendingDialog ? Promise.resolve([]) : this.errorAlerts();
    if (expected.some((e) => e.type === 'response')) {
      ps.page.on('request', this.onRequest);
      ps.page.on('response', this.onResponse);
    }
  }
  async ready(): Promise<void> {
    await Promise.all([this.initialInvalid, this.initialAlerts]);
  }
  dispose(): void {
    this.ps.page.off('request', this.onRequest);
    this.ps.page.off('response', this.onResponse);
    this.requests.clear();
    this.responses.length = 0;
  }
  private async errorAlerts(): Promise<string[]> {
    try {
      return (await this.ps.page.locator('[role=alert]').allTextContents()).filter((text) =>
        /\b(error|failed|failure|invalid|rejected)\b/i.test(text),
      );
    } catch {
      return [];
    }
  }
  private async invalidCount(): Promise<number> {
    return this.ps.page
      .locator('[aria-invalid="true"], :user-invalid')
      .count()
      .catch(() => 0);
  }
  private async response(spec: Extract<ExpectSpec, { type: 'response' }>): Promise<boolean> {
    const deadline = Math.min(Date.now() + (spec.timeout ?? 5000), currentScope()?.deadline ?? Infinity);
    const pattern = new RegExp(
      '^' +
        spec.urlPattern
          .split('*')
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    );
    for (;;) {
      for (const response of this.responses) {
        if (
          !pattern.test(response.url()) ||
          (spec.method && response.request().method().toUpperCase() !== spec.method.toUpperCase())
        )
          continue;
        if (
          spec.status !== undefined &&
          !(Array.isArray(spec.status) ? spec.status : [spec.status]).includes(response.status())
        )
          continue;
        if (!spec.json?.length) return spec.status !== undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const body = await Promise.race([
            response.body(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('body timeout')), Math.max(1, deadline - Date.now()));
            }),
          ]);
          if (body.length > 1024 * 1024) continue;
          const json: unknown = JSON.parse(body.toString('utf8'));
          if (
            spec.json.every((check) => {
              let value: unknown = json;
              for (const key of check.path.split('.')) {
                if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
                value = (value as Record<string, unknown>)[key];
              }
              return (
                (check.equals === undefined || value === check.equals) &&
                (check.matches === undefined || new RegExp(check.matches).test(String(value)))
              );
            })
          )
            return true;
        } catch {
          /* Unavailable/malformed bodies cannot prove success. */
        } finally {
          clearTimeout(timer);
        }
      }
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(50, deadline - Date.now()));
    }
  }
  private async check(spec: ExpectSpec): Promise<boolean> {
    if (spec.type === 'response') return this.response(spec);
    if (spec.type === 'no_new_errors') {
      const e = this.s.monitor.errors(this.ps.id, this.seq);
      return !e.console.length && !e.network.length;
    }
    if (spec.type === 'validation') {
      const r = spec.target ? await resolveTarget(this.ps, spec.target, 1000, 'read') : undefined;
      const probe = (n: Element) => {
        const root = n.closest('form') ?? n;
        const invalid =
          root.matches('[aria-invalid="true"], :user-invalid') ||
          !!root.querySelector('[aria-invalid="true"], :user-invalid');
        const ids = [n, ...root.querySelectorAll('[aria-invalid="true"], :user-invalid')]
          .flatMap((e) =>
            `${e.getAttribute('aria-errormessage') ?? ''} ${e.getAttribute('aria-describedby') ?? ''}`.split(
              /\s+/,
            ),
          )
          .filter(Boolean);
        return {
          invalid,
          message: ids.map((id) => n.ownerDocument.getElementById(id)?.textContent ?? '').join(' '),
        };
      };
      const state =
        r?.kind === 'handle'
          ? await r.handle.evaluate(probe)
          : await (r?.locator ?? this.ps.page.locator('body')).evaluate(probe);
      return (
        state.invalid === (spec.outcome === 'invalid') &&
        (!spec.message || state.message.includes(spec.message))
      );
    }
    return (
      await this.assertions.check(
        {
          ...spec,
          timeout: Math.max(
            0,
            Math.min(spec.timeout ?? 5000, (currentScope()?.deadline ?? Infinity) - Date.now()),
          ),
        },
        {
          session: this.s.name,
          project: this.s.project,
          pageId: this.ps.id,
          lockedPage: this.ps,
          sinceSeq: this.seq,
        },
        currentScope()?.signal,
      )
    ).passed;
  }
  async verify(result: ActionResult, retryable: boolean): Promise<ActionOutcome> {
    const evidence: ActionOutcome['evidence'] = [];
    for (const field of result.fieldResults ?? []) {
      if (field.verified || !['filled', 'skipped'].includes(field.status))
        evidence.push({
          kind: 'assertion',
          passed: field.verified === true,
          detail: `Field ${field.index + 1}: ${field.status}${field.code ? ` (${field.code})` : ''}`,
        });
    }
    if (!result.dialog)
      for (const spec of this.expected) {
        let passed = false;
        try {
          passed = await this.check(spec);
        } catch {
          /* Evidence must never contain raw values/errors. */
        }
        evidence.push({
          kind: 'assertion',
          passed,
          detail: `${spec.type} expectation ${passed ? 'passed' : 'failed'}`,
        });
      }
    const window = this.s.monitor.network({ pageId: this.ps.id, sinceSeq: this.seq, limit: 500 });
    const entries = window.entries;
    const incomplete = window.total > entries.length;
    const errors = this.s.monitor.errors(this.ps.id, this.seq);
    const failed = entries.filter((e) => e.failure || (e.status !== null && e.status >= 400));
    const pending = entries.filter(
      (e) =>
        e.status === null && !e.failure && ['xhr', 'fetch', 'document', 'script'].includes(e.resourceType),
    ).length;
    const invalid = !result.dialog && (await this.invalidCount()) > (await this.initialInvalid);
    if (failed.length && this.signals.network !== false)
      evidence.push({ kind: 'network', passed: false, detail: `${failed.length} failed request(s)` });
    const oldAlerts = await this.initialAlerts;
    const newAlerts = !result.dialog && (await this.errorAlerts()).some((text) => !oldAlerts.includes(text));
    if (newAlerts && this.signals.alerts !== false)
      evidence.push({ kind: 'assertion', passed: false, detail: 'New error alert' });
    if (invalid && this.signals.validation !== false)
      evidence.push({ kind: 'assertion', passed: false, detail: 'New invalid form state' });
    if (result.dialog)
      evidence.push({ kind: 'dialog', passed: false, detail: 'Dialog interrupted the action' });
    const bad = evidence.some((e) => !e.passed && e.kind !== 'dialog');
    const status =
      result.dialog || pending || incomplete
        ? 'INDETERMINATE'
        : bad
          ? 'FAILED'
          : this.expected.length ||
              (result.fieldResults?.length && result.fieldResults.every((f) => f.verified))
            ? 'VERIFIED'
            : 'UNVERIFIED';
    const url = this.redactor.url(this.ps.page.url());
    return {
      actionExecuted: result.dialog ? 'dispatched' : 'completed',
      verificationStatus: status,
      observed: {
        uiChanges: result.diff?.changes.length ?? 0,
        network: {
          completed: entries.length - pending,
          failed: failed.map((e) => ({ method: e.method, url: this.redactor.url(e.url), status: e.status })),
          pending,
        },
        consoleErrors: errors.console.length,
        ...(url !== this.redactor.url(this.initialUrl)
          ? { urlChanged: { from: this.redactor.url(this.initialUrl), to: url } }
          : {}),
        ...(result.dialog
          ? { dialog: { type: result.dialog.type, message: this.redactor.text(result.dialog.message) } }
          : {}),
      },
      evidence,
      retryable: retryable && !result.dialog && !pending && !incomplete,
      warnings: incomplete ? ['Action-window network evidence was truncated'] : [],
      ...(status === 'FAILED'
        ? { failureReason: 'Action-window failure or unmet expectation' }
        : status === 'INDETERMINATE'
          ? { failureReason: 'Dialog or pending requests; inspect before acting again' }
          : {}),
    };
  }
}
