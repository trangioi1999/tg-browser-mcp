import { z } from 'zod';
import { AssertionSchema } from '../workflow/workflow-schema.js';
import { TargetShape } from './target.js';

export const ExpectSpecSchema = z.union([
  AssertionSchema,
  z.object({
    type: z.literal('response'),
    urlPattern: z.string(),
    method: z.string().optional(),
    status: z.union([z.number().int(), z.array(z.number().int())]).optional(),
    json: z
      .array(
        z.object({
          path: z.string(),
          equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
          matches: z.string().optional(),
        }),
      )
      .optional(),
    timeout: z.number().int().min(0).max(120000).optional(),
  }),
  z.object({
    type: z.literal('validation'),
    target: z.object(TargetShape).optional(),
    outcome: z.enum(['valid', 'invalid']),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('no_new_errors') }),
]);
export type ExpectSpec = z.infer<typeof ExpectSpecSchema>;
export type VerificationStatus = 'VERIFIED' | 'FAILED' | 'UNVERIFIED' | 'INDETERMINATE';
export type DispatchState = 'not_started' | 'dispatched' | 'completed' | 'unknown';
export interface ActionOutcome {
  actionExecuted: DispatchState;
  verificationStatus: VerificationStatus;
  /** Redacted summaries only: callers already possess the original expectation values. */
  expected?: ExpectSpec[];
  observed: {
    urlChanged?: { from: string; to: string };
    uiChanges: number;
    network: {
      completed: number;
      failed: Array<{ method: string; url: string; status: number | null }>;
      pending: number;
    };
    consoleErrors: number;
    dialog?: { type: string; message: string };
  };
  evidence: Array<{ kind: 'assertion' | 'network' | 'diff' | 'dialog'; passed: boolean; detail: string }>;
  retryable: boolean;
  warnings: string[];
  failureReason?: string;
}

/** Evidence is unknown on an interrupted action; zero counts are not proof of completion. */
export function interruptedOutcome(actionExecuted: DispatchState): ActionOutcome {
  return {
    actionExecuted,
    verificationStatus: 'INDETERMINATE',
    observed: { uiChanges: 0, network: { completed: 0, failed: [], pending: 0 }, consoleErrors: 0 },
    evidence: [],
    retryable: actionExecuted === 'not_started',
    warnings: [
      'Observation incomplete. Re-snapshot and check whether the submission happened before acting again.',
    ],
  };
}
