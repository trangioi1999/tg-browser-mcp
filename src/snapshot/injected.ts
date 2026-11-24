/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Code in this file is serialized with Function.prototype.toString() and executed inside the page
 * (each frame) by Playwright. It MUST be self-contained: no imports, no closures over module scope,
 * no TypeScript helpers that emit runtime code.
 */

export interface RawNode {
  ref?: string;
  role: string;
  name?: string;
  value?: string;
  states?: string[];
  level?: number;
  /** For iframes: index used by Node to splice in the child frame snapshot. */
  frameSlot?: boolean;
  children?: RawNode[];
}

export interface CollectArgs {
  nextIndex: number;
  maxDepth: number;
  maxTextLength: number;
  includeText: boolean;
  sensitiveKeys: string[];
  /** Ref of the element to scope the snapshot to. */
  scopeRef?: string;
  maxNodes: number;
}

export interface CollectResult {
  docId: string;
  nextIndex: number;
  nodes: RawNode[];
  nodeCount: number;
  truncatedByNodeLimit: boolean;
  scopeMissing?: boolean;
  url: string;
  title: string;
  framework?: string;
}

export interface ElementDescription {
  role: string;
  name: string;
  tag: string;
  testId?: string;
  placeholder?: string;
  id?: string;
  label?: string;
  inputType?: string;
  connected: boolean;
  native?: 'select' | 'input' | 'textarea' | 'other';
  multiple?: boolean;
  editable: boolean;
}

/** Installs (idempotently) the TG snapshot engine into the current document. */
export function tgInstall(): void {
  const w = window as any;
  if (w.__tgSnap && w.__tgSnap.version === 1) return;

  const INTERACTIVE = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'option',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
    'file',
    'clickable',
  ]);
  const NAME_FROM_CONTENT = new Set([
    'button',
    'link',
    'heading',
    'option',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
    'cell',
    'columnheader',
    'rowheader',
    'listitem',
    'alert',
    'status',
    'tooltip',
    'clickable',
    'switch',
    'summary',
    'gridcell',
    'legend',
    'caption',
  ]);
  const KEEP_ROLES = new Set([
    ...INTERACTIVE,
    'heading',
    'img',
    'navigation',
    'main',
    'banner',
    'contentinfo',
    'complementary',
    'region',
    'form',
    'search',
    'dialog',
    'alertdialog',
    'alert',
    'status',
    'log',
    'marquee',
    'timer',
    'progressbar',
    'meter',
    'table',
    'grid',
    'treegrid',
    'row',
    'cell',
    'gridcell',
    'columnheader',
    'rowheader',
    'list',
    'listitem',
    'menu',
    'menubar',
    'tablist',
    'tabpanel',
    'tree',
    'group',
    'radiogroup',
    'toolbar',
    'tooltip',
    'iframe',
    'article',
    'figure',
    'separator',
  ]);
  const LANDMARK_SKIP_INSIDE = new Set(['article', 'section', 'main', 'aside', 'nav']);

  const st = {
    version: 1,
    docId: Math.random().toString(36).slice(2, 10),
    map: new Map<string, Element>(),
    ids: new WeakMap<Element, string>(),
  };

  function norm(s: string | null | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim();
  }

  function implicitRole(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) {
      const first = explicit.trim().split(/\s+/)[0]!.toLowerCase();
      if (first === 'presentation' || first === 'none') return '';
      return first;
    }
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : '';
      case 'button':
        return 'button';
      case 'summary':
        return 'button';
      case 'input': {
        const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
        if (t === 'hidden') return '';
        if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
        if (t === 'checkbox') return el.getAttribute('switch') !== null ? 'switch' : 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        if (t === 'search') return 'searchbox';
        if (t === 'file') return 'file';
        if ((el as HTMLInputElement).list) return 'combobox';
        return 'textbox';
      }
      case 'select':
        return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1
          ? 'listbox'
          : 'combobox';
      case 'option':
        return 'option';
      case 'textarea':
        return 'textbox';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'img':
        return el.getAttribute('alt') === '' ? '' : 'img';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'aside':
        return 'complementary';
      case 'header':
      case 'footer': {
        let p = el.parentElement;
        while (p) {
          if (LANDMARK_SKIP_INSIDE.has(p.tagName.toLowerCase())) return '';
          p = p.parentElement;
        }
        return tag === 'header' ? 'banner' : 'contentinfo';
      }
      case 'form':
        return 'form';
      case 'section':
        return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
      case 'dialog':
        return 'dialog';
      case 'table':
        return 'table';
      case 'tr':
        return 'row';
      case 'th':
        return el.closest('thead') || el.getAttribute('scope') === 'col' ? 'columnheader' : 'rowheader';
      case 'td':
        return 'cell';
      case 'ul':
      case 'ol':
      case 'menu':
        return 'list';
      case 'li':
        return 'listitem';
      case 'fieldset':
        return 'group';
      case 'progress':
        return 'progressbar';
      case 'meter':
        return 'meter';
      case 'output':
        return 'status';
      case 'iframe':
      case 'frame':
        return 'iframe';
      case 'article':
        return 'article';
      case 'figure':
        return 'figure';
      case 'hr':
        return '';
      case 'svg':
        return el.getAttribute('aria-label') ? 'img' : '';
    }
    if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable)
      return 'textbox';
    return '';
  }

  function textOf(el: Element): string {
    // innerText respects CSS visibility; fall back to textContent for non-rendered nodes.
    const h = el as HTMLElement;
    return norm(typeof h.innerText === 'string' ? h.innerText : el.textContent);
  }

  function byIds(el: Element, attr: string): string {
    const ids = el.getAttribute(attr);
    if (!ids) return '';
    const root = el.getRootNode() as Document | ShadowRoot;
    return norm(
      ids
        .split(/\s+/)
        .map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id)))
        .filter(Boolean)
        .map((n) => textOf(n as Element))
        .join(' '),
    );
  }

  function hasInteractiveDescendant(el: Element): boolean {
    return !!el.querySelector(
      'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=combobox],[tabindex]:not([tabindex="-1"])',
    );
  }

  function accName(el: Element, role: string): string {
    const lb = byIds(el, 'aria-labelledby');
    if (lb) return lb;
    const al = norm(el.getAttribute('aria-label'));
    if (al) return al;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const input = el as HTMLInputElement;
      const t = (input.type || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(t))
        return norm(input.value) || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : '');
      if (t === 'image') return norm(input.alt) || 'Submit';
      const labels = input.labels
        ? Array.from(input.labels)
            .map((l) => textOf(l))
            .filter(Boolean)
        : [];
      if (labels.length) return labels.join(' ');
      return norm(el.getAttribute('title')) || norm(el.getAttribute('placeholder'));
    }
    if (tag === 'img' || tag === 'area')
      return norm(el.getAttribute('alt')) || norm(el.getAttribute('title'));
    if (tag === 'fieldset') {
      const lg = el.querySelector(':scope > legend');
      if (lg) return textOf(lg);
    }
    if (tag === 'table') {
      const cap = el.querySelector(':scope > caption');
      if (cap) return textOf(cap);
    }
    if (tag === 'figure') {
      const fc = el.querySelector(':scope > figcaption');
      if (fc) return textOf(fc);
    }
    if (tag === 'iframe') return norm(el.getAttribute('title')) || norm(el.getAttribute('name'));
    if (NAME_FROM_CONTENT.has(role)) {
      if (
        role !== 'button' &&
        role !== 'link' &&
        role !== 'option' &&
        role !== 'tab' &&
        role !== 'switch' &&
        hasInteractiveDescendant(el)
      )
        return '';
      const t = textOf(el);
      if (t) return t;
    }
    return norm(el.getAttribute('title'));
  }

  function isSensitive(el: Element, keys: string[]): boolean {
    const input = el as HTMLInputElement;
    if ((input.type || '').toLowerCase() === 'password') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/cc-|one-time-code|current-password|new-password/.test(ac)) return true;
    const hay =
      `${el.getAttribute('name') || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-sensitive') !== null ? 'sensitive' : ''}`.toLowerCase();
    return keys.some((k) => k && hay.includes(k));
  }

  function states(el: Element, role: string): string[] {
    const out: string[] = [];
    const h = el as HTMLInputElement;
    const aria = (n: string) => el.getAttribute(`aria-${n}`);
    if (h.disabled || aria('disabled') === 'true' || el.closest('fieldset[disabled]')) out.push('disabled');
    if (
      role === 'checkbox' ||
      role === 'radio' ||
      role === 'switch' ||
      role === 'menuitemcheckbox' ||
      role === 'menuitemradio'
    ) {
      const c = aria('checked');
      if (c === 'mixed' || h.indeterminate) out.push('mixed');
      else if (c === 'true' || (c === null && h.checked)) out.push('checked');
    }
    const ex = aria('expanded');
    if (ex === 'true') out.push('expanded');
    else if (ex === 'false') out.push('collapsed');
    if (aria('selected') === 'true' || (role === 'option' && (el as HTMLOptionElement).selected))
      out.push('selected');
    const pr = aria('pressed');
    if (pr === 'true') out.push('pressed');
    if (h.required || aria('required') === 'true') out.push('required');
    if (h.readOnly || aria('readonly') === 'true') out.push('readonly');
    if (aria('invalid') === 'true' || el.matches(':user-invalid')) out.push('invalid');
    if (aria('current') && aria('current') !== 'false') out.push('current');
    if (aria('busy') === 'true') out.push('busy');
    if (
      el.getAttribute('aria-modal') === 'true' ||
      (el.tagName === 'DIALOG' && (el as HTMLDialogElement).open && el.matches(':modal'))
    )
      out.push('modal');
    if (document.activeElement === el) out.push('focused');
    if (el.tagName === 'TEXTAREA') out.push('multiline');
    return out;
  }

  function valueOf(el: Element, role: string, keys: string[], maxLen: number): string | undefined {
    const tag = el.tagName.toLowerCase();
    let v: string | undefined;
    if (tag === 'input' || tag === 'textarea') {
      const t = ((el as HTMLInputElement).type || '').toLowerCase();
      if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(t)) {
        if (t === 'file') {
          const files = (el as HTMLInputElement).files;
          return files && files.length ? `${files.length} file(s)` : undefined;
        }
        return undefined;
      }
      v = (el as HTMLInputElement).value;
    } else if (tag === 'select') {
      v = Array.from((el as HTMLSelectElement).selectedOptions)
        .map((o) => norm(o.textContent))
        .join(', ');
    } else if (role === 'textbox' && (el as HTMLElement).isContentEditable) {
      v = textOf(el);
    } else if (
      role === 'combobox' ||
      role === 'slider' ||
      role === 'spinbutton' ||
      role === 'progressbar' ||
      role === 'meter'
    ) {
      v = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || undefined;
      if (role === 'combobox' && !v) {
        // Custom comboboxes (mat-select, p-select) render the selected value as text content.
        const t = textOf(el);
        v = t && t !== accName(el, role) ? t : undefined;
      }
    }
    if (!v) return undefined;
    if (isSensitive(el, keys)) return '••••';
    return v.length > maxLen ? `${v.slice(0, maxLen - 1)}…` : v;
  }

  function refFor(el: Element, counter: { n: number }): string {
    let r = st.ids.get(el);
    if (!r || st.map.get(r) !== el) {
      r = `e${counter.n++}`;
      st.ids.set(el, r);
      st.map.set(r, el);
    }
    return r;
  }

  function isPointer(el: Element, style: CSSStyleDeclaration): boolean {
    if (style.cursor !== 'pointer') return false;
    const p = el.parentElement;
    if (p && getComputedStyle(p).cursor === 'pointer') return false;
    return el.hasAttribute('onclick') || el.hasAttribute('tabindex') || !!norm(el.textContent);
  }

  function collect(args: CollectArgs): CollectResult {
    const counter = { n: args.nextIndex };
    let nodeCount = 0;
    let truncated = false;
    const keys = args.sensitiveKeys.map((k) => k.toLowerCase());

    function mergeText(list: RawNode[]): RawNode[] {
      const out: RawNode[] = [];
      for (const n of list) {
        const prev = out[out.length - 1];
        if (n.role === 'text' && prev && prev.role === 'text')
          prev.name = `${prev.name} ${n.name}`.slice(0, args.maxTextLength * 2);
        else out.push(n);
      }
      for (const n of out)
        if (n.role === 'text' && n.name && n.name.length > args.maxTextLength)
          n.name = `${n.name.slice(0, args.maxTextLength - 1)}…`;
      return out;
    }

    function walkChildren(parent: Element | ShadowRoot, depth: number, suppressText: boolean): RawNode[] {
      const out: RawNode[] = [];
      const host = parent instanceof Element ? parent : null;
      const kids: Node[] = [];
      if (host && host.shadowRoot) kids.push(...Array.from(host.shadowRoot.childNodes));
      if (host && host.tagName === 'SLOT')
        kids.push(...(host as HTMLSlotElement).assignedNodes({ flatten: true }));
      else kids.push(...Array.from(parent.childNodes));
      for (const k of kids) {
        if (nodeCount >= args.maxNodes) {
          truncated = true;
          break;
        }
        if (k.nodeType === Node.TEXT_NODE) {
          if (suppressText || !args.includeText) continue;
          const t = norm(k.textContent);
          if (t) out.push({ role: 'text', name: t });
        } else if (k.nodeType === Node.ELEMENT_NODE) {
          out.push(...walk(k as Element, depth, suppressText));
        }
      }
      return out;
    }

    function walk(el: Element, depth: number, suppressText: boolean): RawNode[] {
      const tag = el.tagName.toLowerCase();
      if (
        tag === 'script' ||
        tag === 'style' ||
        tag === 'noscript' ||
        tag === 'template' ||
        tag === 'head' ||
        tag === 'meta' ||
        tag === 'link'
      )
        return [];
      if (el.getAttribute('aria-hidden') === 'true') return [];
      if (el.hasAttribute('inert')) return [];
      const style = getComputedStyle(el);
      if (style.display === 'none') return [];
      if (tag === 'dialog' && !(el as HTMLDialogElement).open) return [];
      if (tag === 'details' && !(el as HTMLDetailsElement).open) {
        const summary = el.querySelector(':scope > summary');
        return summary ? walk(summary, depth, suppressText) : [];
      }
      const hiddenSelf = style.visibility === 'hidden' || style.visibility === 'collapse';
      let role = hiddenSelf ? '' : implicitRole(el);
      // A <label> bound to a control is just its caption (clicking it toggles the control): not a separate target.
      const isControlLabel = tag === 'label' && !!(el as HTMLLabelElement).control;
      if (!role && !hiddenSelf && !isControlLabel && isPointer(el, style)) role = 'clickable';
      if (role && !KEEP_ROLES.has(role)) role = '';
      if (role === 'list' || role === 'group' || role === 'form' || role === 'figure' || role === 'article') {
        // Unnamed structural containers add tokens without meaning: flatten them.
        if (role !== 'list' && !accName(el, role)) role = '';
      }
      if (!role) {
        // <label> text duplicates the accessible name of its control: keep only the control.
        const labelsControl = tag === 'label' && !!(el as HTMLLabelElement).control;
        const labelledById =
          !!el.id && !!el.ownerDocument.querySelector(`[aria-labelledby~="${CSS.escape(el.id)}"]`);
        return mergeText(walkChildren(el, depth, suppressText || labelsControl || labelledById));
      }

      nodeCount++;
      const node: RawNode = { role, ref: refFor(el, counter) };
      const name = accName(el, role);
      if (name)
        node.name =
          name.length > args.maxTextLength * 2 ? `${name.slice(0, args.maxTextLength * 2 - 1)}…` : name;
      const s = states(el, role);
      if (s.length) node.states = s;
      if (role === 'heading') {
        const lvl = el.getAttribute('aria-level') || (/^h[1-6]$/.test(tag) ? tag.slice(1) : '');
        if (lvl) node.level = Number(lvl);
      }
      const v = valueOf(el, role, keys, args.maxTextLength);
      if (v !== undefined) node.value = v;
      if (role === 'iframe') {
        node.frameSlot = true;
        return [node];
      }
      if (depth + 1 > args.maxDepth) {
        if (el.children.length) node.children = [{ role: 'text', name: '… (max depth)' }];
        return [node];
      }
      // Name already carries the text content: do not repeat descendant text.
      const nameFromContent =
        !!name &&
        NAME_FROM_CONTENT.has(role) &&
        !el.getAttribute('aria-label') &&
        !el.getAttribute('aria-labelledby');
      if (
        role === 'textbox' ||
        role === 'searchbox' ||
        (role === 'combobox' && tag === 'select') ||
        role === 'img'
      )
        return [node];
      let children: RawNode[];
      if (tag === 'select') children = [];
      else children = mergeText(walkChildren(el, depth + 1, suppressText || nameFromContent));
      if (role === 'combobox' && node.value) children = children.filter((c) => c.role !== 'text');
      if (children.length) node.children = children;
      return [node];
    }

    let root: Element | null = document.body ?? document.documentElement;
    let scopeMissing = false;
    if (args.scopeRef) {
      const s = st.map.get(args.scopeRef);
      if (s && s.isConnected) root = s;
      else scopeMissing = true;
    }
    const nodes =
      root && !scopeMissing
        ? args.scopeRef
          ? walk(root, 0, false)
          : mergeText(walkChildren(root, 0, false))
        : [];
    // Drop map entries for detached elements to avoid leaks on long-lived SPAs.
    if (st.map.size > 20000) for (const [r, e] of st.map) if (!e.isConnected) st.map.delete(r);

    let framework: string | undefined;
    const ngv = document.querySelector('[ng-version]');
    if (ngv) {
      framework = `Angular ${ngv.getAttribute('ng-version')}`;
      if (
        document.querySelector(
          '.mat-mdc-form-field, .mat-mdc-button, .cdk-overlay-container, [class*="mat-mdc-"]',
        )
      )
        framework += ' + Angular Material';
      if (document.querySelector('[class*="p-component"]')) framework += ' + PrimeNG';
    } else if ((window as any).React || document.querySelector('[data-reactroot]')) framework = 'React';
    else if ((window as any).__VUE__) framework = 'Vue';

    return {
      docId: st.docId,
      nextIndex: counter.n,
      nodes,
      nodeCount,
      truncatedByNodeLimit: truncated,
      ...(scopeMissing ? { scopeMissing } : {}),
      url: location.href,
      title: document.title,
      ...(framework ? { framework } : {}),
    };
  }

  function describe(el: Element): ElementDescription {
    const role = implicitRole(el) || 'generic';
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const labels = input.labels
      ? Array.from(input.labels)
          .map((l) => textOf(l))
          .filter(Boolean)
      : [];
    const d: ElementDescription = {
      role,
      name: accName(el, role),
      tag,
      connected: el.isConnected,
      native:
        tag === 'select' ? 'select' : tag === 'input' ? 'input' : tag === 'textarea' ? 'textarea' : 'other',
      editable: tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable,
    };
    const tid =
      el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    if (tid) d.testId = tid;
    const ph = el.getAttribute('placeholder');
    if (ph) d.placeholder = ph;
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) d.id = el.id;
    if (labels.length) d.label = labels.join(' ');
    if (tag === 'input') d.inputType = (input.type || 'text').toLowerCase();
    if (tag === 'select') d.multiple = (el as HTMLSelectElement).multiple;
    return d;
  }

  w.__tgSnap = {
    ...st,
    collect,
    describe,
    get(ref: string): Element | null {
      const e = st.map.get(ref);
      return e && e.isConnected ? e : null;
    },
    refOf(el: Element): string | undefined {
      return st.ids.get(el);
    },
  };
  Object.defineProperty(w, '__tgSnap', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: w.__tgSnap,
  });
}

let installScript: string | undefined;

/**
 * The install script as a string expression. Transpilers such as esbuild (`keepNames`, used by
 * tsx/vitest) inject helper calls like `__name()` into function bodies; the shim makes the
 * serialized function independent of the toolchain that compiled it.
 */
export function installScriptSource(): string {
  installScript ??= `(() => { const __name = (f) => f; (${tgInstall.toString()})(); })()`;
  return installScript;
}

export function collectScriptSource(args: CollectArgs): string {
  return `window.__tgSnap.collect(${JSON.stringify(args)})`;
}
