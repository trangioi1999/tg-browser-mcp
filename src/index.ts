#!/usr/bin/env node
import { main } from './cli/cli.js';

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
