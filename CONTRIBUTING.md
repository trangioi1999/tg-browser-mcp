# Contributing

```bash
npm ci && npm run build
npm run lint && npm run typecheck && npm test
```

- TypeScript strict; small modules; no new runtime dependencies without discussion.
- Never write to stdout from server code (ESLint `no-console` allows only `console.error` outside the CLI).
- New tools: add to `src/tools/*` with Zod input, profile, risk, timeout; run `npm run docs:tools`; add tests.
- Security-relevant changes need a test in `tests/integration/security.test.ts` or `tests/unit/*`.
- Browser tests use the local fixture app (`tests/fixtures/app/server.mjs`) — never public websites.
- Record significant decisions as ADRs in `docs/adr/`.
- Commits: conventional style (`feat:`, `fix:`, `docs:`…).
