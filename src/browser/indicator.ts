/**
 * Visible "controlled by TG Browser MCP" badge for headed browsers, so a human can tell which
 * window the agent is driving. It must never change what the agent sees or can do:
 *  - closed shadow root (page CSS/JS cannot style or query its content),
 *  - aria-hidden on the host (skipped by snapshots and ARIA trees),
 *  - pointer-events: none (clicks and hit-testing pass through),
 *  - hidden in screenshots via INDICATOR_HIDE_CSS.
 */
export const INDICATOR_ID = '__tg-browser-indicator';
export const INDICATOR_HIDE_CSS = `#${INDICATOR_ID}{display:none!important}`;

/** Runs in the page (as an init script) — must be self-contained. */
export function installIndicator(label: string): void {
  if (window.top !== window) return;
  const mount = () => {
    if (document.getElementById('__tg-browser-indicator') || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = '__tg-browser-indicator';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'all:initial;position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'closed' });
    const pill = document.createElement('div');
    pill.textContent = label;
    pill.style.cssText =
      'font:600 11px/1.4 system-ui,-apple-system,sans-serif;color:#fff;background:#6d28d9;' +
      'padding:3px 8px;border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,.3);opacity:.92;white-space:nowrap';
    root.appendChild(pill);
    document.documentElement.appendChild(host);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
