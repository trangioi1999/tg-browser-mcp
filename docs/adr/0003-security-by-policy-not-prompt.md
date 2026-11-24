# ADR-0003: Security enforced by policy, not by the model

Status: accepted

Decision: every dangerous capability (network targets, files, high-risk tools, destructive clicks) is gated by configuration and human approval (MCP elicitation). No tool argument lets the model self-approve. No eval/shell tools. Domain policy is enforced at the context level (routes, redirect hook, WebSocket routes, service workers blocked) in addition to tool-level checks.
Consequences: prompt injection cannot escalate beyond the configured policy; some legitimate flows need explicit config (internal hosts → `allowedDomains`).
