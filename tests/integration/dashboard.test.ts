import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { markdownReport, junitReport } from '../../src/testing/report-generator.js';
import { createFixtureServer } from '../fixtures/app/server.mjs';
import { hasPlaywrightFfmpeg, testHarness } from '../helpers.js';
import { startDashboard } from '../../src/ui/server.js';
import { WorkflowEngine } from '../../src/workflow/workflow-engine.js';
import { WorkflowSchema } from '../../src/workflow/workflow-schema.js';

// Video recording needs Playwright's ffmpeg build; skip with a reason instead of failing (TGB-011).
const VIDEO = hasPlaywrightFfmpeg();
if (!VIDEO)
  console.warn(
    '[dashboard.test] Playwright ffmpeg is not installed: video tests skipped (run `npx playwright install ffmpeg`).',
  );

describe('dashboard fixture history', () => {
  it.skipIf(!VIDEO)(
    'persists screenshot, errors, workflow, trace and video after the harness exits',
    async () => {
      const app = createFixtureServer();
      const h = testHarness({ recording: { video: 'on' }, output: { screenshots: 'file' } });
      let ui: Awaited<ReturnType<typeof startDashboard>> | undefined;
      try {
        const base = await app.listen();
        const session = await h.createSession({ name: 'demo' });
        await session.navigate(base);
        await session.raw.page().page.evaluate(() => console.error('fixture dashboard error'));
        await h.actions.screenshot({}, { session: 'demo' });
        await h.actions.traceStart({ session: 'demo' });
        await session.navigate(base + '/login');
        await h.actions.traceStop(undefined, { session: 'demo' });
        const engine = new WorkflowEngine(h);
        const result = await engine.execute(
          WorkflowSchema.parse({
            name: 'dashboard-smoke',
            steps: [{ id: 'visit', session: 'demo', action: 'navigate', input: { url: base } }],
          }),
        );
        const reportDir = path.join(h.config.dataDir, 'artifacts', 'default', 'reports');
        fs.mkdirSync(reportDir, { recursive: true });
        const reports = [path.join(reportDir, 'smoke.md'), path.join(reportDir, 'smoke.xml')];
        fs.writeFileSync(reports[0]!, markdownReport([result]));
        fs.writeFileSync(reports[1]!, junitReport([result]));
        engine.recordReports([result.runId], reports);
        await h.close();
        ui = await startDashboard(h.config, {
          port: 0,
          file: path.join(h.config.dataDir, 'dashboard.config.json'),
        });
        const headers = { Authorization: 'Bearer ' + new URL(ui.url).searchParams.get('token') };
        const get = async (route: string) => (await fetch(ui!.origin + '/api/' + route, { headers })).json();
        const summary = await get('sessions/default/demo');
        expect(summary.counts.screenshots).toBe(1);
        expect(summary.counts.videos).toBeGreaterThan(0);
        expect(summary.counts.traces).toBe(1);
        expect(summary.counts.errors).toBeGreaterThan(0);
        const events = await get('sessions/default/demo/events');
        expect(events.map((e: { type: string }) => e.type)).toEqual(
          expect.arrayContaining([
            'session.created',
            'session.closed',
            'console.error',
            'navigation.completed',
            'screenshot.created',
            'video.saved',
            'workflow.completed',
          ]),
        );
        const run = await get('runs/default/' + result.runId);
        expect(run.status).toBe('passed');
        expect(run.steps[0].session).toBe('demo');
        expect(run.reports).toHaveLength(2);
        expect((await fetch(ui.origin + summary.screenshots[0].url, { headers })).status).toBe(200);
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try {
          const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
          await page.goto(ui.url);
          await page.getByRole('heading', { name: 'Tổng quan', exact: true }).waitFor();
          expect(page.url()).toBe(ui.origin + '/');
          await page.getByRole('link', { name: 'Sessions', exact: true }).click();
          await page.getByRole('link', { name: 'default / demo', exact: true }).click();
          await page.getByRole('tab', { name: 'Ảnh chụp' }).click();
          await page.locator('.gallery button').click();
          expect(await page.getByRole('dialog').isVisible()).toBe(true);
          await page.keyboard.press('Escape');
          await page.getByRole('link', { name: 'Cài đặt', exact: true }).click();
          await page.getByText('JSON nâng cao', { exact: true }).click();
          await page
            .getByLabel('Cấu hình JSON', { exact: true })
            .fill(JSON.stringify({ ...h.config, tools: { profile: 'invalid' } }));
          await page.getByRole('button', { name: 'Lưu cấu hình' }).click();
          await page.getByRole('status').filter({ hasText: 'tools.profile' }).waitFor();
          await page.getByLabel('Cấu hình JSON', { exact: true }).fill(JSON.stringify(h.config));
          await page.getByRole('button', { name: 'Lưu cấu hình' }).click();
          await page.getByRole('status').filter({ hasText: 'Đã lưu' }).waitFor();
        } finally {
          await browser.close();
        }
      } finally {
        await h.close();
        await ui?.close();
        await app.close();
      }
    },
  );
  it.skipIf(!VIDEO)(
    'honors overrides and retains videos only after failures, including persistent contexts',
    async () => {
      const h = testHarness({ recording: { video: 'retain-on-failure' } });
      const app = createFixtureServer();
      try {
        const base = await app.listen();
        for (const [name, recordVideo, persistent, fail] of [
          ['clean', undefined, false, false],
          ['failed', undefined, true, true],
          ['forced', true, false, false],
          ['disabled', false, false, true],
        ] as const) {
          const s = await h.createSession({
            name,
            persistent,
            ...(recordVideo !== undefined ? { recordVideo } : {}),
          });
          await s.navigate(base);
          if (fail)
            h.events.emit('action.failed', {
              sessionId: s.raw.id,
              action: 'click',
              code: 'FAILED',
              message: 'fixture failure',
              correlationId: 'c',
            });
          await s.close();
          const dir = path.join(h.config.dataDir, 'artifacts', 'default', name, 'videos');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
          expect(files.filter((f) => f.endsWith('.webm')).length).toBe(
            name === 'failed' || name === 'forced' ? 1 : 0,
          );
        }
      } finally {
        await h.close();
        await app.close();
      }
    },
  );
});
