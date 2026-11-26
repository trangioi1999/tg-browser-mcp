import { z } from 'zod';
import { AssertionSchema } from '../workflow/workflow-schema.js';
export const StoredRunSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  workflow: z.string(),
  project: z.string(),
  status: z.enum(['running', 'passed', 'failed', 'cancelled']),
  startedAt: z.string().datetime(),
  durationMs: z.number().optional(),
  variables: z.record(z.string(), z.string()),
  reports: z.array(z.string()).optional(),
  finishedAt: z.string().datetime().optional(),
  failure: z
    .object({
      stepId: z.string(),
      code: z.string(),
      message: z.string(),
      url: z.string().optional(),
      screenshot: z.string().optional(),
      console: z.string().optional(),
      network: z.string().optional(),
    })
    .optional(),
  steps: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      session: z.string(),
      status: z.enum(['passed', 'failed', 'skipped', 'pending', 'running', 'cancelled']),
      attempts: z.number(),
      durationMs: z.number(),
      message: z.string(),
      name: z.string().optional(),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
          retryable: z.boolean().optional(),
          suggestion: z.string().optional(),
        })
        .optional(),
      extracted: z.object({ variable: z.string(), value: z.string() }).optional(),
      assertion: z
        .object({
          passed: z.boolean(),
          type: AssertionSchema.shape.type,
          target: z.string().optional(),
          expected: z.string().optional(),
          actual: z.string().optional(),
          message: z.string(),
          durationMs: z.number(),
        })
        .optional(),
    }),
  ),
});
