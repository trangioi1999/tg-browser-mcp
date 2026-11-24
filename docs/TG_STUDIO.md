# TG Studio integration

TG Studio (not part of this repo) embeds the harness directly and subscribes to typed lifecycle events.

```ts
import { BrowserHarness, WorkflowEngine, type HarnessEventName } from 'tg-browser-mcp';

const harness = new BrowserHarness({ project: 'banking-bpa', browser: { headless: false } });

// Forward every event to the Studio UI (e.g. over a WebSocket).
harness.events.onAny((event: HarnessEventName, payload) => studio.send({ event, payload, ts: Date.now() }));

const agentA = await harness.createSession({ name: 'agent-a', agentId: 'frontend-agent' });
await agentA.navigate('http://localhost:4200');
const { text } = await agentA.snapshot();
await agentA.click({ role: 'button', name: 'Create' });

const engine = new WorkflowEngine(harness);
const run = await engine.execute(definition, { variables: { BASE_URL: 'http://localhost:4200' } });
```

## Events

| Event                                                                           | Payload                                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `browser.started` / `browser.closed`                                            | browserId, engine/channel, mode / reason (`requested`, `disconnected`, `shutdown`) |
| `session.created` / `session.restored` / `session.closed`                       | sessionId, name, project (+ cookie/origin counts)                                  |
| `navigation.started` / `navigation.completed`                                   | sessionId, pageId, url (query stripped), status, durationMs                        |
| `action.started` / `action.completed` / `action.failed`                         | sessionId, pageId, action, target, correlationId, durationMs / code + message      |
| `workflow.started` / `workflow.step` / `workflow.completed` / `workflow.failed` | runId, workflow, stepId, status, code                                              |
| `screenshot.created`                                                            | sessionId, pageId, path, bytes                                                     |

Payloads never contain typed values, cookies or tokens. Observer exceptions are swallowed so the UI cannot break automation.

## Isolation between agents and projects

- One `BrowserHarness` per project (its `dataDir`/`project` namespace sessions, workflows, runs).
- Sessions carry `agentId`; give each agent its own sessions (contexts) — cookies never cross contexts.
- For hard isolation (separate browser processes), use one harness per agent, or the HTTP transport (one harness per MCP session).
- Approvals: `harness.setApprovalHandler(async ({ title, detail }) => (await studio.confirm(title, detail)) ? 'approved' : 'declined')`.

A runnable example: [examples/tg-studio-events.ts](../examples/tg-studio-events.ts).
