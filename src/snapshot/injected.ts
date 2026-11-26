/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Code in this file is serialized with Function.prototype.toString() and executed inside the page
 * (each frame) by Playwright. It MUST be self-contained: no imports, no closures over module scope,
 * no TypeScript helpers that emit runtime code.
 */

export interface RefGuard {
  role: string;
  tag: string;
  inputType?: string;
  name: string;
  keys: Record<string, string>;
  container?: string;
  rowKey?: string;
}

export interface RawNode {
  guard?: RefGuard;
  description?: ElementDescription;
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
  complete: boolean;
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
  guard?: RefGuard;
  warning?: string;
  connected: boolean;
  native?: 'select' | 'input' | 'textarea' | 'other';
  multiple?: boolean;
  editable: boolean;
}

/** Installs (idempotently) the TG snapshot engine into the current document. */
export function tgInstall(nonce: string, accessKey: string): void {
  const w = window as any;
  if ('__tgSnap' in w) {
    if (w.__tgSnap?.nonce === nonce) return;
    throw new Error('TARGET_CHANGED: untrusted snapshot engine; re-snapshot in a fresh document');
  }
  // Capture native reads before page scripts run. This is defense in depth, not a
  // security boundary: a page can still change its actual DOM/labels, including
  // between verification and dispatch. Already-loaded documents are less trusted.
  const getComputedStyle = window.getComputedStyle.bind(window);
  const attr = Function.prototype.call.bind(Element.prototype.getAttribute) as (
    e: Element,
    n: string,
  ) => string | null;
  const query = Function.prototype.call.bind(Element.prototype.querySelector) as (
    e: Element,
    s: string,
  ) => Element | null;
  const closest = Function.prototype.call.bind(Element.prototype.closest) as (
    e: Element,
    s: string,
  ) => Element | null;
  const inputType = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type')!.get!,
  ) as (e: Element) => string;
  const innerText = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText')!.get!,
  ) as (e: Element) => string;
  const textContent = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')!.get!,
  ) as (e: Node) => string;
  const inputLabels = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'labels')!.get!,
  );
  const selectLabels = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'labels')!.get!,
  );
  const textareaLabels = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'labels')!.get!,
  );
  const inputValue = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!,
  ) as (e: Element) => string;
  const labelsOf = (el: Element): NodeListOf<HTMLLabelElement> | undefined =>
    el.tagName === 'INPUT'
      ? inputLabels(el)
      : el.tagName === 'SELECT'
        ? selectLabels(el)
        : el.tagName === 'TEXTAREA'
          ? textareaLabels(el)
          : undefined;
  const mapGet = Function.prototype.call.bind(Map.prototype.get);
  const mapSize = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!);
  const mapForEach = Function.prototype.call.bind(Map.prototype.forEach);
  const mapDelete = Function.prototype.call.bind(Map.prototype.delete);
  const mapSet = Function.prototype.call.bind(Map.prototype.set);
  const weakGet = Function.prototype.call.bind(WeakMap.prototype.get);
  const weakSet = Function.prototype.call.bind(WeakMap.prototype.set);
  // Playwright's main-world return-value serializer uses Map.prototype.get.
  // A page can poison that serializer even though our own maps use captured
  // methods. Cross the value boundary as a primitive string, then parse in Node.
  const stringify = JSON.stringify;
  const freeze = Object.freeze;
  const defineProperty = Object.defineProperty;
  const authorize = (key: string) => {
    if (key !== accessKey) throw new Error('Unauthorized snapshot access');
  };

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
    const explicit = attr(el, 'role');
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
        const t = inputType(el).toLowerCase();
        if (t === 'hidden') return '';
        if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
        if (t === 'checkbox') return attr(el, 'switch') !== null ? 'switch' : 'checkbox';
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
        return attr(el, 'alt') === '' ? '' : 'img';
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
        return closest(el, 'thead') || attr(el, 'scope') === 'col' ? 'columnheader' : 'rowheader';
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
        return attr(el, 'aria-label') ? 'img' : '';
    }
    if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable)
      return 'textbox';
    return '';
  }

  function textOf(el: Element): string {
    // innerText respects CSS visibility; fall back to textContent for non-rendered nodes.
    return norm(el instanceof HTMLElement ? innerText(el) : textContent(el));
  }

  function byIds(el: Element, attribute: string): string {
    const ids = attr(el, attribute);
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
    return !!query(
      el,
      'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=combobox],[tabindex]:not([tabindex="-1"])',
    );
  }

  function accName(el: Element, role: string): string {
    const lb = byIds(el, 'aria-labelledby');
    if (lb) return lb;
    const al = norm(attr(el, 'aria-label'));
    if (al) return al;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const t = (el.tagName === 'INPUT' ? inputType(el) : '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(t))
        return norm(inputValue(el)) || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : '');
      if (t === 'image') return norm(attr(el, 'alt')) || 'Submit';
      const labels = labelsOf(el)
        ? Array.from(labelsOf(el)!)
            .map((l) => textOf(l))
            .filter(Boolean)
        : [];
      if (labels.length) return labels.join(' ');
      return norm(attr(el, 'title')) || norm(attr(el, 'placeholder'));
    }
    if (tag === 'img' || tag === 'area') return norm(attr(el, 'alt')) || norm(attr(el, 'title'));
    if (tag === 'fieldset') {
      const lg = query(el, ':scope > legend');
      if (lg) return textOf(lg);
    }
    if (tag === 'table') {
      const cap = query(el, ':scope > caption');
      if (cap) return textOf(cap);
    }
    if (tag === 'figure') {
      const fc = query(el, ':scope > figcaption');
      if (fc) return textOf(fc);
    }
    if (tag === 'iframe') return norm(attr(el, 'title')) || norm(attr(el, 'name'));
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
    return norm(attr(el, 'title'));
  }

  function isSensitive(el: Element, keys: string[]): boolean {
    if ((el.tagName === 'INPUT' ? inputType(el) : '').toLowerCase() === 'password') return true;
    const ac = (attr(el, 'autocomplete') || '').toLowerCase();
    if (/cc-|one-time-code|current-password|new-password/.test(ac)) return true;
    const hay =
      `${attr(el, 'name') || ''} ${attr(el, 'id') || ''} ${attr(el, 'aria-label') || ''} ${attr(el, 'data-sensitive') !== null ? 'sensitive' : ''}`.toLowerCase();
    return keys.some((k) => k && hay.includes(k));
  }

  function states(el: Element, role: string): string[] {
    const out: string[] = [];
    const h = el as HTMLInputElement;
    const aria = (n: string) => attr(el, `aria-${n}`);
    if (h.disabled || aria('disabled') === 'true' || closest(el, 'fieldset[disabled]')) out.push('disabled');
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
      attr(el, 'aria-modal') === 'true' ||
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
      const t = tag === 'input' ? inputType(el).toLowerCase() : '';
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
      v = attr(el, 'aria-valuetext') || attr(el, 'aria-valuenow') || undefined;
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
    let r = weakGet(st.ids, el);
    if (!r || mapGet(st.map, r) !== el) {
      r = `e${counter.n++}`;
      weakSet(st.ids, el, r);
      mapSet(st.map, r, el);
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
    let depthTruncated = false;
    let textTruncated = false;
    const keys = args.sensitiveKeys.map((k) => k.toLowerCase());

    function mergeText(list: RawNode[]): RawNode[] {
      const out: RawNode[] = [];
      for (const n of list) {
        const prev = out[out.length - 1];
        if (n.role === 'text' && prev && prev.role === 'text') {
          if (`${prev.name} ${n.name}`.length > args.maxTextLength * 2) textTruncated = true;
          prev.name = `${prev.name} ${n.name}`.slice(0, args.maxTextLength * 2);
        } else out.push(n);
      }
      for (const n of out)
        if (n.role === 'text' && n.name && n.name.length > args.maxTextLength) {
          textTruncated = true;
          n.name = `${n.name.slice(0, args.maxTextLength - 1)}…`;
        }
      return out;
    }

    function walkChildren(parent: Element | ShadowRoot, depth: number, suppressText: boolean): RawNode[] {
      const out: RawNode[] = [];
      const host = parent instanceof Element ? parent : null;
      const kids: Node[] = [];
      if (host && host.shadowRoot) kids.push(...Array.from(host.shadowRoot.childNodes));
      else if (host && host.tagName === 'SLOT') {
        const assigned = (host as HTMLSlotElement).assignedNodes({ flatten: true });
        kids.push(...(assigned.length ? assigned : Array.from(host.childNodes)));
      } else kids.push(...Array.from(parent.childNodes));
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
      if (attr(el, 'aria-hidden') === 'true') return [];
      if (el.hasAttribute('inert')) return [];
      const style = getComputedStyle(el);
      if (style.display === 'none') return [];
      if (tag === 'dialog' && !(el as HTMLDialogElement).open) return [];
      if (tag === 'details' && !(el as HTMLDetailsElement).open) {
        const summary = query(el, ':scope > summary');
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
      node.guard = guard(el);
      node.description = describe(el);
      const name = accName(el, role);
      if (name.length > args.maxTextLength * 2) textTruncated = true;
      if (name)
        node.name =
          name.length > args.maxTextLength * 2 ? `${name.slice(0, args.maxTextLength * 2 - 1)}…` : name;
      const s = states(el, role);
      if (s.length) node.states = s;
      if (role === 'heading') {
        const lvl = attr(el, 'aria-level') || (/^h[1-6]$/.test(tag) ? tag.slice(1) : '');
        if (lvl) node.level = Number(lvl);
      }
      const v = valueOf(el, role, keys, Number.MAX_SAFE_INTEGER);
      if (v !== undefined) {
        if (v.length > args.maxTextLength) textTruncated = true;
        node.value = v.length > args.maxTextLength ? `${v.slice(0, args.maxTextLength - 1)}…` : v;
      }
      if (role === 'iframe') {
        node.frameSlot = true;
        return [node];
      }
      if (depth + 1 > args.maxDepth) {
        if (el.children.length || el.shadowRoot?.childNodes.length) {
          depthTruncated = true;
          node.children = [{ role: 'text', name: '… (max depth)' }];
        }
        return [node];
      }
      // Name already carries the text content: do not repeat descendant text.
      const nameFromContent =
        !!name && NAME_FROM_CONTENT.has(role) && !attr(el, 'aria-label') && !attr(el, 'aria-labelledby');
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
      const s = mapGet(st.map, args.scopeRef);
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
    if (mapSize(st.map) > 20000)
      mapForEach(st.map, (e: Element, r: string) => {
        if (!e.isConnected) mapDelete(st.map, r);
      });

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
      complete: !truncated && !depthTruncated && !textTruncated && !scopeMissing && !args.scopeRef && !!root,
      ...(scopeMissing ? { scopeMissing } : {}),
      url: location.href,
      title: document.title,
      ...(framework ? { framework } : {}),
    };
  }

  function guard(el: Element): RefGuard {
    const role = implicitRole(el) || 'generic';
    const keys: Record<string, string> = {};
    for (const key of ['data-testid', 'data-test-id', 'data-test', 'formcontrolname', 'name', 'id']) {
      const value = attr(el, key);
      if (value) keys[key] = value;
    }
    const row = closest(el, 'tr,[role=row],[data-row-key]');
    const cell = row && query(row, '[role=rowheader],th,td,[role=cell],[role=gridcell]');
    const rowKey = row
      ? norm(attr(row, 'data-row-key') || (cell ? textOf(cell) : '')).slice(0, 80)
      : undefined;
    const container = closest(
      el,
      'form,dialog,[role=form],[role=dialog],[role=alertdialog],[role=region],section[aria-label],section[aria-labelledby]',
    );
    return {
      role,
      tag: el.tagName.toLowerCase(),
      name: accName(el, role),
      keys,
      ...(el.tagName === 'INPUT' ? { inputType: inputType(el) } : {}),
      ...(rowKey !== undefined ? { rowKey } : {}),
      ...(container
        ? {
            container: `${implicitRole(container)}:${accName(container, implicitRole(container))}:${attr(container, 'id') || ''}`,
          }
        : {}),
    };
  }

  function describe(el: Element): ElementDescription {
    const role = implicitRole(el) || 'generic';
    const tag = el.tagName.toLowerCase();
    const labels = labelsOf(el)
      ? Array.from(labelsOf(el)!)
          .map((l) => textOf(l))
          .filter(Boolean)
      : [];
    const d: ElementDescription = {
      role,
      guard: guard(el),
      name: accName(el, role),
      tag,
      connected: el.isConnected,
      native:
        tag === 'select' ? 'select' : tag === 'input' ? 'input' : tag === 'textarea' ? 'textarea' : 'other',
      editable: tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable,
    };
    const tid = attr(el, 'data-testid') || attr(el, 'data-test-id') || attr(el, 'data-test');
    if (tid) d.testId = tid;
    const ph = attr(el, 'placeholder');
    if (ph) d.placeholder = ph;
    const id = attr(el, 'id');
    if (id && /^[A-Za-z][\w-]*$/.test(id)) d.id = id;
    if (labels.length) d.label = labels.join(' ');
    if (tag === 'input') d.inputType = inputType(el).toLowerCase();
    if (tag === 'select') d.multiple = (el as HTMLSelectElement).multiple;
    return d;
  }

  defineProperty(w, '__tgSnap', {
    enumerable: false,
    configurable: false,
    writable: false,
    value: freeze({
      nonce,
      docId: st.docId,
      collect(args: CollectArgs, key: string) {
        authorize(key);
        return stringify(collect(args));
      },
      describe(el: Element, key: string) {
        authorize(key);
        return stringify(describe(el));
      },
      get(ref: string, key: string): Element | null {
        authorize(key);
        const e = mapGet(st.map, ref);
        return e && e.isConnected ? e : null;
      },
      refOf(el: Element, key: string): string | undefined {
        authorize(key);
        return weakGet(st.ids, el);
      },
    }),
  });
}

export const snapshotNonce = crypto.randomUUID();
export const snapshotAccessKey = crypto.randomUUID();
let installScript: string | undefined;

/**
 * The install script as a string expression. Transpilers such as esbuild (`keepNames`, used by
 * tsx/vitest) inject helper calls like `__name()` into function bodies; the shim makes the
 * serialized function independent of the toolchain that compiled it.
 */
export function installScriptSource(): string {
  installScript ??= `(() => { const __name = (f) => f; (${tgInstall.toString()})(${JSON.stringify(snapshotNonce)}, ${JSON.stringify(snapshotAccessKey)}); })()`;
  return installScript;
}

export function collectScriptSource(args: CollectArgs): string {
  return `window.__tgSnap.collect(${JSON.stringify(args)}, ${JSON.stringify(snapshotAccessKey)})`;
}
