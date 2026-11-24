import type { ActionExecutor, RecordedAction } from '../harness/action-executor.js';
import type { WorkflowInput } from './workflow-schema.js';
import { TgError } from '../shared/errors.js';

type Step = WorkflowInput['steps'][number];

const ACTION_MAP: Record<string, Step['action']> = {
  navigate: 'navigate',
  click: 'click',
  double_click: 'double_click',
  fill: 'fill',
  type: 'type',
  press: 'press',
  select: 'select',
  check: 'check',
  uncheck: 'uncheck',
  hover: 'hover',
};

/**
 * Records successful browser actions (from any session) into a replayable workflow.
 * Element refs are converted to semantic locators so the workflow survives future runs.
 * Values typed into sensitive fields are replaced by ${secret.FIELD} placeholders.
 */
export class WorkflowRecorder {
  private recording:
    { name: string; steps: Step[]; sessions: Set<string> | undefined; startedAt: number } | undefined;

  constructor(private readonly actions: ActionExecutor) {}

  get active(): boolean {
    return !!this.recording;
  }

  start(name: string, sessions?: string[]): void {
    if (this.recording)
      throw new TgError(
        'INVALID_ARGUMENT',
        `Already recording "${this.recording.name}"; call workflow_record_stop first`,
      );
    this.recording = {
      name,
      steps: [],
      sessions: sessions?.length ? new Set(sessions) : undefined,
      startedAt: Date.now(),
    };
    this.actions.onRecorded = (a) => this.onAction(a);
  }

  private onAction(a: RecordedAction): void {
    const r = this.recording;
    if (!r) return;
    if (r.sessions && !r.sessions.has(a.session)) return;
    const action = ACTION_MAP[a.action];
    if (!action) return;
    const input: Record<string, unknown> = { ...(a.target ?? {}), ...a.input };
    if (a.sensitive) {
      const key =
        String(a.target?.label ?? a.target?.name ?? 'value')
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, '_')
          .replace(/^_|_$/g, '') || 'VALUE';
      if ('value' in input) input.value = `\${secret.${key}}`;
      if ('text' in input && action === 'type') input.text = `\${secret.${key}}`;
    }
    // Collapse consecutive fills of the same field.
    const prev = r.steps[r.steps.length - 1];
    if (
      prev &&
      action === 'fill' &&
      prev.action === 'fill' &&
      prev.session === a.session &&
      JSON.stringify({ ...prev.input, value: 0 }) === JSON.stringify({ ...input, value: 0 })
    ) {
      prev.input = input;
      return;
    }
    r.steps.push({ id: `step-${r.steps.length + 1}`, session: a.session, action, input });
  }

  stop(): WorkflowInput {
    const r = this.recording;
    if (!r) throw new TgError('INVALID_ARGUMENT', 'Not recording');
    this.recording = undefined;
    this.actions.onRecorded = undefined;
    if (r.steps.length === 0) throw new TgError('WORKFLOW_INVALID', 'No actions were recorded');
    return { name: r.name, description: `Recorded ${new Date(r.startedAt).toISOString()}`, steps: r.steps };
  }

  status(): { recording: boolean; name?: string; steps?: number } {
    return this.recording
      ? { recording: true, name: this.recording.name, steps: this.recording.steps.length }
      : { recording: false };
  }
}
