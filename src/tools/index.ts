import type { ToolDef } from '../server/tool-registry.js';
import { browserTools } from './browser-tools.js';
import { navigationTools, interactionTools, inspectionTools, tabTools } from './page-tools.js';
import { debugTools } from './debug-tools.js';
import { sessionTools, networkTools } from './session-network-tools.js';
import { workflowTools, testingTools } from './workflow-tools.js';

/** Every tool known to the server. Which are advertised depends on the tool profile. */
export const ALL_TOOLS: ToolDef[] = [
  ...browserTools,
  ...navigationTools,
  ...interactionTools,
  ...inspectionTools,
  ...tabTools,
  ...debugTools,
  ...sessionTools,
  ...networkTools,
  ...workflowTools,
  ...testingTools,
] as unknown as ToolDef[];
