/**
 * Hermetic test environment (doc 13 "Hermeticity", TGB-011).
 *
 * Tests never inherit the developer's or CI runner's proxy settings or TG Browser configuration:
 * an ambient HTTPS_PROXY changed `network_diagnose` results, and TG_BROWSER_* would change the
 * browser, data dir or project under test. Tests that need a proxy configure it explicitly.
 * TG_LOG_LEVEL is set by vitest.config.ts.
 */
const AMBIENT = /^((https?|all|no)_proxy|TG_BROWSER(_.*)?)$/i;

for (const key of Object.keys(process.env)) {
  if (AMBIENT.test(key)) delete process.env[key];
}
