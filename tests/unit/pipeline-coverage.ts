/** Optional native V8 coverage probe; source-map decoding uses Vite's existing codec dependency. */
import { Session } from 'node:inspector';
import { writeFileSync } from 'node:fs';
import { decode } from '@jridgewell/sourcemap-codec';
import { beforeAll, afterAll } from 'vitest';
if (process.env.TGB_PIPELINE_COVERAGE) {
  const session = new Session();
  session.connect();
  const post = (method: string, params = {}) =>
    new Promise<unknown>((resolve, reject) => {
      session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)));
    });
  beforeAll(async () => {
    await post('Debugger.enable');
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  });
  afterAll(async () => {
    const result = (await post('Profiler.takePreciseCoverage')) as {
      result: Array<{
        scriptId: string;
        url: string;
        functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>;
      }>;
    };
    const pipeline = result.result.find((s) => s.url.endsWith('/action-pipeline.ts'));
    if (!pipeline) throw new Error('Pipeline missing from V8 coverage');
    const { scriptSource: source } = (await post('Debugger.getScriptSource', {
      scriptId: pipeline.scriptId,
    })) as { scriptSource: string };
    const encoded = source.match(/sourceMappingURL=data:application\/json[^,]*,([^\n]+)/)?.[1];
    if (!encoded) throw new Error('Pipeline source map missing');
    const map = JSON.parse(Buffer.from(encoded, 'base64').toString()) as { mappings: string };
    const ranges = pipeline.functions.flatMap((f) => f.ranges);
    const lines = source.split('\n');
    const coverage = new Map<number, boolean>();
    let offset = 0;
    for (const [line, segments] of decode(map.mappings).entries()) {
      for (const segment of segments) {
        if (segment.length < 4) continue;
        const position = offset + segment[0];
        // The innermost V8 range determines execution (an uncovered branch overrides its parent).
        const range = ranges
          .filter((r) => r.startOffset <= position && r.endOffset > position)
          .sort((a, b) => a.endOffset - a.startOffset - (b.endOffset - b.startOffset))[0];
        if (range) coverage.set(segment[2]!, (coverage.get(segment[2]!) ?? false) || range.count > 0);
      }
      offset += (lines[line]?.length ?? 0) + 1;
    }
    const covered = [...coverage.values()].filter(Boolean).length;
    const summary = { covered, total: coverage.size, percent: (100 * covered) / coverage.size };
    writeFileSync(process.env.TGB_PIPELINE_COVERAGE!, JSON.stringify({ summary, pipeline, source }));
    await post('Profiler.stopPreciseCoverage');
    session.disconnect();
    if (summary.percent < 90)
      throw new Error(`Pipeline mapped-line coverage ${summary.percent.toFixed(2)}% is below 90%`);
  });
}
