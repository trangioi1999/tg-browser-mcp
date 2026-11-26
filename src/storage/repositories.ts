import type { Workflow } from '../workflow/workflow-schema.js';
import type { RunRecord } from '../workflow/workflow-engine.js';

export type RunSummary = Pick<RunRecord, 'runId' | 'workflow' | 'status' | 'startedAt' | 'durationMs'>;
export interface RunRepository {
  save(run: RunRecord): void;
  get(runId: string): RunRecord;
  list(limit?: number): RunSummary[];
}
export interface WorkflowRepository {
  save(workflow: Workflow, options?: { expectedSha?: string; overwrite?: boolean }): string;
  load(name: string): Workflow;
  list(): Array<{ name: string; steps: number; sessions: string[]; file: string }>;
}
export interface Artifact {
  path: string;
  kind: 'screenshot' | 'video' | 'trace' | 'report';
  bytes: number;
  sha256?: string;
  runId?: string;
  session?: string;
  expiresAt?: string;
}
export interface ArtifactRepository {
  allocate(runId: string, name: string): string;
  register(artifact: Artifact): void;
  list(): Artifact[];
  expire(now: string): string[];
}
