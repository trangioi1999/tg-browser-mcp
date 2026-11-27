import type { ScopeKey } from '../memory/scope.js';
import type { ElementFingerprint, FingerprintedElement, Locator } from '../memory/fingerprint.js';
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

// ───────────────────────── Browser Memory (doc 06 §7) ─────────────────────────

export type VersionStatus = 'observed' | 'candidate' | 'verified' | 'active' | 'archived' | 'rejected';
export interface ScopeRow {
  id: number;
  project: string;
  origin: string;
  environment: string;
  authContext: string;
  createdAt: string;
}
export interface PageRow {
  id: number;
  scopeId: number;
  routeKey: string;
  pageKey: string;
  activeVersionId: number | undefined;
  createdAt: string;
}
export interface PageVersionRow {
  id: number;
  pageId: number;
  versionNo: number;
  variantKey: string;
  shapeHash: string;
  labelHash: string;
  buildHint: string | undefined;
  status: VersionStatus;
  complete: boolean;
  elementCount: number;
  capped: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  observations: number;
  verifiedAt: string | undefined;
}
export interface ElementObservationRow {
  id: number;
  memoryId: string;
  semanticKey: string;
  role: string;
  fingerprint: ElementFingerprint;
  locators: Locator[];
  verifiedAt: string | undefined;
}
export interface MemoryEventRow {
  id: number;
  ts: string;
  actor: string;
  kind: string;
  subject: string;
  detail: Record<string, unknown>;
}
export interface Observation {
  project: string;
  scopeId: number;
  routeKey: string;
  pageKey: string;
  variantKey: string;
  shapeHash: string;
  labelHash: string;
  buildHint?: string;
  /** Already capped to the per-page element limit. */
  elements: FingerprintedElement[];
  totalElements: number;
  capped: boolean;
  at: string;
  maxPagesPerScope: number;
  maxVersionsPerPage: number;
}
export type ObservationResult =
  | {
      rejected?: undefined;
      page: PageRow;
      version: PageVersionRow;
      created: boolean;
      pageCreated: boolean;
      /** Active version of the same variant at observation time. */
      active?: PageVersionRow;
    }
  | { rejected: string };
export interface VerificationResult {
  marked: number;
  activated: boolean;
}
export interface MemoryRepository {
  upsertScope(s: ScopeKey): number;
  findPage(scopeId: number, pageKey: string): PageRow | undefined;
  recordObservation(o: Observation): ObservationResult;
  markVerified(
    project: string,
    scopeId: number,
    versionId: number,
    semanticKeys: string[],
    at: string,
  ): VerificationResult;
  activateVersion(project: string, scopeId: number, versionId: number): void;
  versions(scopeId: number, pageId: number, limit: number): PageVersionRow[];
  elementsOf(scopeId: number, pageVersionId: number): ElementObservationRow[];
  purge(project: string, scopeId?: number): number;
}
