import { cpSync, mkdirSync } from 'node:fs';
mkdirSync(new URL('../dist/ui/public/', import.meta.url), { recursive: true });
cpSync(new URL('../src/ui/public/', import.meta.url), new URL('../dist/ui/public/', import.meta.url), {
  recursive: true,
});
