import type { Locator } from 'playwright';
import type { PageState } from '../../session/session.js';
import type { Resolved } from '../../harness/target.js';
import { TgError } from '../../shared/errors.js';

/**
 * Generic ARIA combobox/listbox selection, used for non-native selects. This covers:
 *  - Angular Material mat-select (role=combobox, options in a CDK overlay with role=option)
 *  - Angular Material mat-autocomplete (editable combobox; type then pick option)
 *  - PrimeNG p-select / p-dropdown / p-multiselect (role=combobox, options role=option)
 *  - Any WAI-ARIA compliant custom select
 * Options are scoped to the aria-controls popup when present, otherwise looked up page-wide
 * (overlays are usually rendered at <body> level). Only visible options are considered.
 * Matching: a unique exact (case-insensitive, trimmed) match, else a unique substring match; several
 * matches raise ELEMENT_AMBIGUOUS with the candidates instead of picking one (D18).
 */
export async function selectCustomOption(
  ps: PageState,
  r: Resolved,
  values: string[],
  timeout: number,
): Promise<string[]> {
  const el = r.kind === 'handle' ? r.handle : r.locator;
  const chosen: string[] = [];
  const frame = r.frame;
  // Scope options to the popup the combobox controls (aria-controls/aria-owns) when available.
  const controls =
    (await el.getAttribute('aria-controls').catch(() => null)) ??
    (await el.getAttribute('aria-owns').catch(() => null));
  const scope = (): Locator => {
    const id = controls?.split(/\s+/)[0];
    const base = id
      ? frame.locator(`[id="${id.replace(/"/g, '\\"')}"]`).getByRole('option')
      : frame.getByRole('option');
    return base.filter({ visible: true });
  };
  // Escape closes compliant popups; many hand-written widgets ignore it, so toggle the combobox as a fallback.
  // A popup left open covers the controls below it and breaks the agent's next action.
  const closePopup = async (): Promise<void> => {
    await ps.page.keyboard.press('Escape').catch(() => undefined);
    if (!r.desc.editable && (await anyOptionVisible(scope())))
      await el.click({ timeout: Math.min(timeout, 2000) }).catch(() => undefined);
  };
  for (const [i, value] of values.entries()) {
    if (r.desc.editable) {
      await el.fill(value, { timeout });
    } else if (i === 0 || !(await anyOptionVisible(scope()))) {
      await el.click({ timeout });
    }
    const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exact = scope().filter({ hasText: new RegExp(`^\\s*${esc}\\s*$`, 'i') });
    // Wait for the overlay to render (CDK/PrimeNG animations), then prefer an exact match.
    await scope()
      .first()
      .waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) })
      .catch(() => undefined);
    // D18: exact match first; a substring match only when exactly one option contains the text.
    // Several candidates are an error (never silently click the first one).
    const option = (await exact.count()) > 0 ? exact : scope().filter({ hasText: value });
    try {
      await option.first().waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) });
    } catch {
      const available = await scope()
        .allInnerTexts()
        .catch(() => [] as string[]);
      await closePopup();
      throw new TgError('ELEMENT_NOT_FOUND', `Option "${value}" not found`, {
        context: {
          available: available
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 20),
        },
        suggestion: 'Use one of the available option names.',
      });
    }
    if ((await option.count()) > 1) {
      const candidates = await option.allInnerTexts().catch(() => [] as string[]);
      await closePopup();
      throw new TgError(
        'ELEMENT_AMBIGUOUS',
        `Option "${value}" is ambiguous: ${candidates.length} options match`,
        {
          context: {
            candidates: candidates
              .map((t) => t.trim())
              .filter(Boolean)
              .slice(0, 20),
          },
          suggestion: 'Use the full, exact option name (or a snapshot ref of the option).',
          retryable: false,
        },
      );
    }
    await option.first().click({ timeout });
    chosen.push(value);
  }
  // Multi-selects keep the overlay open; close it so the page state is clean.
  if (values.length > 1 && (await anyOptionVisible(scope()))) await closePopup();
  return chosen;
}

async function anyOptionVisible(l: Locator): Promise<boolean> {
  return l
    .first()
    .isVisible()
    .catch(() => false);
}
