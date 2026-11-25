import vm from 'node:vm';
import { expect, it } from 'vitest';
import {
  collectScriptSource,
  installScriptSource,
  snapshotAccessKey,
  snapshotNonce,
  type CollectResult,
} from '../../src/snapshot/injected.js';

// Minimal native surface: exercises the serialized installer without a browser.
function realm() {
  const context = vm.createContext({});
  vm.runInContext(
    `
    class Node {
      static ELEMENT_NODE = 1;
      static TEXT_NODE = 3;
      nodeType = 1;
      childNodes = [];
      isConnected = true;
      get textContent() { return this._text || ''; }
    }
    class Element extends Node {
      constructor(tagName = 'DIV', attrs = {}) { super(); this.tagName = tagName; this.attrs = attrs; }
      getAttribute(name) { return this.attrs[name] ?? null; }
      hasAttribute(name) { return name in this.attrs; }
      querySelector() { return null; }
      closest() { return null; }
      matches() { return false; }
    }
    class HTMLElement extends Element { get innerText() { return this._text || ''; } }
    class HTMLInputElement extends HTMLElement { get type() { return 'password'; } get labels() { return []; } get value() { return this._value || ''; } }
    class HTMLSelectElement extends HTMLElement { get labels() { return []; } }
    class HTMLTextAreaElement extends HTMLElement { get labels() { return []; } }
    const window = globalThis;
    window.getComputedStyle = () => ({});
  `,
    context,
  );
  return context;
}
it('serializes without external closures and seals the API and ref state', () => {
  const context = realm();
  vm.runInContext(installScriptSource(), context);
  vm.runInContext(installScriptSource(), context);
  expect(vm.runInContext('window.__tgSnap.nonce', context)).toBe(snapshotNonce);
  expect(vm.runInContext('Object.isFrozen(window.__tgSnap)', context)).toBe(true);
  expect(vm.runInContext('Object.getOwnPropertyDescriptor(window, "__tgSnap").configurable', context)).toBe(
    false,
  );
  expect(vm.runInContext('window.__tgSnap.map', context)).toBeUndefined();
  expect(() => vm.runInContext('window.__tgSnap.get("e1", "fake")', context)).toThrow('Unauthorized');
  expect(() => vm.runInContext('window.__tgSnap.collect({}, "fake")', context)).toThrow('Unauthorized');
  expect(() => vm.runInContext('Object.defineProperty(window, "__tgSnap", {value:{}})', context)).toThrow();
  // Mutating native Map/WeakMap prototypes cannot change the captured ref lookup.
  vm.runInContext(
    'Map.prototype.get = () => ({isConnected:true}); WeakMap.prototype.get = () => "e1";',
    context,
  );
  expect(
    vm.runInContext(`window.__tgSnap.get("e1", ${JSON.stringify(snapshotAccessKey)})`, context),
  ).toBeNull();
});
it('rejects a pre-installed impostor rather than adopting its public version field', () => {
  const context = realm();
  vm.runInContext('window.__tgSnap = { version: 1 };', context);
  expect(() => vm.runInContext(installScriptSource(), context)).toThrow('TARGET_CHANGED');
});

it('rejects an undefined but reserved engine property', () => {
  const context = realm();
  vm.runInContext('Object.defineProperty(window, "__tgSnap", {value:undefined});', context);
  expect(() => vm.runInContext(installScriptSource(), context)).toThrow('TARGET_CHANGED');
});

it('collects and describes through a primitive transport after hostile prototype tampering', () => {
  const context = realm();
  vm.runInContext(
    `
    const danger = new HTMLElement('BUTTON', {id:'danger'});
    danger._text = 'Delete everything';
    const password = new HTMLInputElement('INPUT', {id:'ordinary',type:'password'});
    password._value = 'fixture-private-value';
    const body = new HTMLElement('BODY');
    body.childNodes = [danger, password];
    const document = {body, title:'Hostile page', querySelector: () => null};
    const location = {href:'http://fixture/hostile'};
  `,
    context,
  );
  vm.runInContext(installScriptSource(), context);
  vm.runInContext(
    `
    Object.defineProperty(HTMLInputElement.prototype, 'type', {get: () => 'text'});
    Element.prototype.getAttribute = () => null;
    Object.defineProperty(HTMLElement.prototype, 'innerText', {get: () => 'Harmless help'});
    Map.prototype.get = () => danger;
    WeakMap.prototype.get = () => 'e1';
    JSON.stringify = () => 'tampered';
    // The relevant branch of Playwright's main-world return-value serializer:
    // objects hit the poisoned visited-map lookup; strings bypass it.
    function transport(value) {
      if (typeof value === 'string') return value;
      const id = new Map().get(value);
      if (id) return {ref:id};
      throw new Error('Unexpected unpoisoned object transport');
    }
  `,
    context,
  );
  expect(vm.runInContext('transport({nodes:[]}).ref === danger', context)).toBe(true);
  const script = collectScriptSource({
    nextIndex: 1,
    maxDepth: 40,
    maxTextLength: 200,
    includeText: true,
    sensitiveKeys: [],
    maxNodes: 4000,
  });
  const wire = vm.runInContext(`transport(${script})`, context);
  expect(typeof wire).toBe('string');
  const result = JSON.parse(wire) as CollectResult;
  expect(result.nodes).toMatchObject([
    { ref: 'e1', role: 'button', name: 'Delete everything' },
    { ref: 'e2', role: 'textbox', value: '••••' },
  ]);
  expect(wire).not.toContain('fixture-private-value');
  const description = vm.runInContext(
    `transport(window.__tgSnap.describe(danger, ${JSON.stringify(snapshotAccessKey)}))`,
    context,
  );
  expect(JSON.parse(description)).toMatchObject({ name: 'Delete everything', role: 'button' });
  expect(
    vm.runInContext(`window.__tgSnap.get('e2', ${JSON.stringify(snapshotAccessKey)}) === password`, context),
  ).toBe(true);
});
