import { z } from 'zod';
import { TargetSchema } from '../harness/target.js';

export const StepActions = [
  'navigate',
  'click',
  'double_click',
  'fill',
  'fill_form',
  'type',
  'press',
  'select',
  'check',
  'uncheck',
  'hover',
  'wait',
  'assert',
  'extract',
  'screenshot',
  'snapshot',
  'dialog',
  'save_session',
  'new_tab',
  'switch_tab',
] as const;
export type StepAction = (typeof StepActions)[number];

/** Actions that are safe to retry automatically. Clicks/typing/submissions are not. */
export const IDEMPOTENT_ACTIONS = new Set<StepAction>([
  'navigate',
  'fill',
  'fill_form',
  'select',
  'check',
  'uncheck',
  'hover',
  'wait',
  'assert',
  'extract',
  'screenshot',
  'snapshot',
]);

export const AssertionSchema = z.object({
  type: z.enum([
    'visible',
    'hidden',
    'text',
    'value',
    'url',
    'title',
    'count',
    'attribute',
    'enabled',
    'disabled',
    'checked',
    'no_console_errors',
    'no_failed_requests',
  ]),
  target: TargetSchema.partial().optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  contains: z.string().optional(),
  matches: z.string().optional().describe('Regular expression'),
  attribute: z.string().optional(),
  timeout: z.number().int().min(0).max(120_000).optional(),
  message: z.string().optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export const ExtractSchema = z.object({
  variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  from: z.enum(['text', 'value', 'attribute', 'url', 'title']).default('text'),
  target: TargetSchema.partial().optional(),
  attribute: z.string().optional(),
  /** Regex; the first capture group (or whole match) becomes the value. */
  pattern: z.string().optional(),
});

export const StepSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  name: z.string().optional(),
  session: z.string().default('default'),
  action: z.enum(StepActions),
  input: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).default([]),
  /** Condition: "${var}", "!${var}", "${a} == 'x'", "${a} != 'x'". */
  when: z.string().optional(),
  timeout: z.number().int().min(100).max(300_000).optional(),
  retry: z
    .object({
      attempts: z.number().int().min(0).max(5),
      delayMs: z.number().int().min(0).max(30_000).default(500),
    })
    .optional(),
  /** Mark a non-idempotent action as safe to retry (e.g. a click that only opens a menu). */
  idempotent: z.boolean().optional(),
  continueOnError: z.boolean().default(false),
  extract: ExtractSchema.optional(),
  assert: AssertionSchema.optional(),
});
export type WorkflowStep = z.infer<typeof StepSchema>;

export const WorkflowSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  version: z.literal(1).default(1),
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  sessions: z
    .record(
      z.string(),
      z.object({
        persistent: z.boolean().optional(),
        restore: z.boolean().optional(),
        browser: z.string().optional(),
      }),
    )
    .default({}),
  defaults: z.object({ timeout: z.number().int().min(100).max(300_000).optional() }).default({}),
  steps: z.array(StepSchema).min(1).max(500),
});
export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowInput = z.input<typeof WorkflowSchema>;
