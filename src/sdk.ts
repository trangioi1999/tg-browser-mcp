/**
 * Public TypeScript SDK. Use the harness directly (TG Studio, scripts, custom agents) or embed
 * the MCP server in your own process.
 */
export { BrowserHarness, HarnessSession } from './harness/browser-harness.js';
export type { ActionResult, ActionContext, SnapshotMode } from './harness/action-executor.js';
export type { Target } from './harness/target.js';
export { WorkflowEngine, type RunRecord, type StepResult } from './workflow/workflow-engine.js';
export { WorkflowRecorder } from './workflow/workflow-recorder.js';
export { validateWorkflow } from './workflow/workflow-validator.js';
export type { Workflow, WorkflowInput, WorkflowStep, Assertion } from './workflow/workflow-schema.js';
export { AssertionEngine } from './testing/assertion-engine.js';
export { generatePlaywrightTest } from './testing/test-generator.js';
export { markdownReport, junitReport } from './testing/report-generator.js';
export { createMcpServer } from './server/mcp-server.js';
export { loadConfig, parseConfig } from './config/load-config.js';
export type { TgConfig, TgConfigInput, ToolProfile } from './config/schema.js';
export type { HarnessEventMap, HarnessEventName } from './shared/events.js';
export { TgError, type ErrorCode } from './shared/errors.js';
export { detectBrowsers } from './browser/browser-detector.js';
export { VERSION } from './version.js';

export type {
  ActionOutcome,
  ExpectSpec,
  VerificationStatus,
  DispatchState,
} from './harness/action-outcome.js';

export type { FillField, FillOptions, FieldResult, FillReport } from './harness/form-filler.js';

export type { VerificationSignals } from './harness/action-verifier.js';
