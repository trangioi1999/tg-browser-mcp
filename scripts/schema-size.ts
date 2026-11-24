/** Prints the size of the advertised tool schemas per profile (what clients load into context). */
import { z } from 'zod';
import { ALL_TOOLS } from '../src/tools/index.js';
import { selectTools } from '../src/server/tool-registry.js';

for (const profile of ['minimal', 'developer', 'testing', 'full'] as const) {
  const tools = selectTools(ALL_TOOLS, { profile, enabled: [], disabled: [] });
  const json = tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: z.toJSONSchema(z.object(t.input)),
  }));
  const chars = JSON.stringify(json).length;
  console.log(
    `${profile.padEnd(10)} tools=${String(tools.length).padStart(2)} chars=${String(chars).padStart(6)} (~${Math.ceil(chars / 4)} tok)`,
  );
}
if (process.argv.includes('--top')) {
  const big = ALL_TOOLS.map(
    (t) => [t.name, JSON.stringify(z.toJSONSchema(z.object(t.input))).length] as const,
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  console.log(big);
}
