import type { ElementHandle, Frame } from 'playwright';
import { TgError } from '../shared/errors.js';
import type { ElementDescription } from './injected.js';

export interface RefEntry {
  ref: string;
  frame: Frame;
  docId: string;
  role: string;
  name: string;
  snapshotId: number;
}

/**
 * Per-page registry of element references. Refs are unique for the lifetime of a page
 * (never reused across navigations), so a ref from an old document is detected as stale
 * instead of silently targeting a different element.
 */
export class RefRegistry {
  private readonly refs = new Map<string, RefEntry>();
  nextIndex = 1;
  snapshotId = 0;

  set(entry: RefEntry): void {
    this.refs.set(entry.ref, entry);
    if (this.refs.size > 50_000) {
      // Bound memory: drop the oldest half.
      const keys = [...this.refs.keys()].slice(0, 25_000);
      for (const k of keys) this.refs.delete(k);
    }
  }

  get(ref: string): RefEntry | undefined {
    return this.refs.get(ref);
  }

  clearFrame(frame: Frame): void {
    for (const [k, v] of this.refs) if (v.frame === frame) this.refs.delete(k);
  }

  /**
   * Resolves a ref to a live ElementHandle. Throws STALE_ELEMENT_REFERENCE when the frame
   * navigated, the element was removed, or its role/name no longer match the snapshot.
   */
  async resolve(
    ref: string,
  ): Promise<{ handle: ElementHandle<Element>; entry: RefEntry; desc: ElementDescription }> {
    if (!/^e\d+$/.test(ref))
      throw new TgError(
        'INVALID_ARGUMENT',
        `Invalid ref "${ref}". Refs look like "e12" and come from browser_snapshot.`,
      );
    const entry = this.refs.get(ref);
    if (!entry) {
      throw new TgError(
        ref && Number(ref.slice(1)) < this.nextIndex ? 'STALE_ELEMENT_REFERENCE' : 'ELEMENT_NOT_FOUND',
        `Element ref ${ref} is not known on this page`,
        { context: { ref } },
      );
    }
    if (entry.frame.isDetached())
      throw new TgError('STALE_ELEMENT_REFERENCE', `Frame for ref ${ref} was detached`, { context: { ref } });
    const res = await entry.frame
      .evaluateHandle(
        ([r, docId]) => {
          const s = (
            window as unknown as {
              __tgSnap?: { docId: string; get(r: string): Element | null; describe(e: Element): unknown };
            }
          ).__tgSnap;
          if (!s || s.docId !== docId) return null;
          const el = s.get(r);
          return el ? { el, desc: s.describe(el) } : null;
        },
        [ref, entry.docId] as const,
      )
      .catch((e: unknown) => {
        throw new TgError('STALE_ELEMENT_REFERENCE', `Ref ${ref} cannot be resolved: page changed`, {
          context: { ref },
          cause: e,
        });
      });
    if (await res.evaluate((x) => x === null)) {
      await res.dispose();
      throw new TgError(
        'STALE_ELEMENT_REFERENCE',
        `Element ${ref} ("${entry.name}") is from a previous page state — the page navigated or re-rendered since the snapshot`,
        { context: { ref, role: entry.role, name: entry.name } },
      );
    }
    const handle = await res.getProperty('el');
    const el = handle.asElement();
    if (!el) {
      await res.dispose();
      throw new TgError(
        'STALE_ELEMENT_REFERENCE',
        `Element ${ref} ("${entry.name}") no longer exists — the page changed since the snapshot`,
        { context: { ref, role: entry.role, name: entry.name } },
      );
    }
    const desc = (await (await res.getProperty('desc')).jsonValue()) as ElementDescription;
    await res.dispose();
    // Role must match. Name may legitimately change (e.g. live counters), but a role change means the
    // ref now points at a different kind of element.
    if (
      entry.role !== 'clickable' &&
      desc.role !== entry.role &&
      !(entry.role === 'file' && desc.role === 'generic')
    ) {
      await el.dispose();
      throw new TgError(
        'STALE_ELEMENT_REFERENCE',
        `Element ${ref} changed from ${entry.role} to ${desc.role}`,
        { context: { ref } },
      );
    }
    return { handle: el as ElementHandle<Element>, entry, desc };
  }
}
