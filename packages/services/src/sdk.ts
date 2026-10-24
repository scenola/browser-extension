/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DAY_MS, isBlockedHost } from '@mt/core';
import type { ServiceReading, Snapshot } from '@mt/core';

import { routeProblem } from './route-safety';

/** What `interpret` receives and answers; a module imports them from here, not from core. */
export type { ServiceReading, Snapshot } from '@mt/core';

/**
 * A service module: a declaration of what to collect — data, read by
 * our own collector and state-path reader — and one pure `interpret`, which runs in a
 * sandbox with no network, no `chrome.*` and no page. A module never runs in a page, a
 * content script or the service worker.
 */

/**
 * One step of a state path, walked by our reader in the page (never by the
 * module):
 *
 * - a property name;
 * - `{ call }`: a zero-argument method the SDK allow-lists for the module, called on the value
 *   it is read from;
 * - `{ routeGroup: n }`: the property named by capture group `n` of the player route that
 *   matched the frame's pathname (a video id, say) — a key only the route knows;
 * - `{ find: { key, routeGroup } }`: the first element of an array whose value at `key` (a
 *   property path in which `"*"` stands for any element of an array) equals that capture group,
 *   with at most 256 elements of any array examined;
 * - `{ pick: [...] }`: the last step only — the value cut down to those properties.
 *
 * A path that cannot be walked reads as nothing; it never throws in the page.
 */
export type StatePathStep =
  | string
  | { readonly call: string }
  | { readonly routeGroup: number }
  | { readonly find: { readonly key: readonly string[]; readonly routeGroup: number } }
  | { readonly pick: readonly string[] };
/** A walk from the page's global object to a player's own state, e.g. `["netflix", …]`. */
export type StatePath = readonly StatePathStep[];

export interface SelectorSpec {
  /** A CSS selector, at most 300 characters. */
  readonly css: string;
  /** Read this attribute instead of the element's trimmed text. */
  readonly attr?: string;
  /** `false` keeps elements that are not visible; visible ones only by default. */
  readonly visibleOnly?: boolean;
  /** At most this many values (1–5; 5 by default). */
  readonly max?: number;
}

/** The whole list of what a module may ask the collector for. */
export interface CollectSpec {
  readonly selectors?: Readonly<Record<string, SelectorSpec>>;
  readonly jsonLd?: true;
  readonly mediaSession?: true;
  readonly openGraph?: true;
  /** The query parameters the snapshot may carry; none otherwise. */
  readonly queryParams?: readonly string[];
  readonly pageState?: Readonly<Record<string, StatePath>>;
  /**
   * Selectors whose visible match means the content ended (credits, a post-play or
   * next-episode screen) or an ad is playing. Core relies on a module declaring the end:
   * a module whose service shows a post-play screen sets `contentEnded` from this signal.
   */
  readonly signals?: { readonly endOfContent?: string; readonly adPlaying?: string };
  /** The bootstrap also looks for the player inside shadow roots. */
  readonly shadowRootPlayer?: true;
}

export interface ServiceDefinition {
  /** Permanent: it is the `provider.<id>` namespace the server remembers answers under. */
  readonly id: string;
  readonly name: string;
  readonly version: `${number}.${number}.${number}`;
  /** Bare domains; each matches itself and its subdomains, and each is a permission. */
  readonly hosts: readonly string[];
  /** When a person last ran the module against the real service, or `null`. */
  readonly verified: { readonly on: string; readonly by: string } | null;
  /** Where a player lives, matched against the pathname (see `matchPlayerRoute`). */
  readonly playerRoutes: readonly RegExp[];
  readonly collect: CollectSpec;
  /** Pure: the snapshot in, a reading (or `null`) out. Runs in the sandbox, ≤ 50 ms. */
  interpret(snapshot: Snapshot): ServiceReading | null;
}

/** The collector's caps for one selector name. */
export const MAX_SELECTOR_LENGTH = 300;
export const MAX_SELECTOR_VALUES = 5;

/** A player route never runs on a longer pathname (`matchPlayerRoute`). */
export const MAX_ROUTE_INPUT = 2048;

const MAX_NAME_LENGTH = 64;
const MAX_VERIFIER_LENGTH = 64;
const MAX_HOSTS = 8;
const MAX_HOST_LENGTH = 253;
const MAX_PLAYER_ROUTES = 8;
const MAX_SELECTORS = 16;
const MAX_QUERY_PARAMS = 8;
const MAX_STATE_PATHS = 4;
const MAX_STATE_PATH_STEPS = 16;
const MAX_STATE_PROPERTY_LENGTH = 128;
/** A route group step names capture groups 1–9; a route has no more worth naming. */
const MAX_ROUTE_GROUP = 9;
/** A `find` key is a short property path; a `pick` keeps a few properties. */
const MAX_FIND_KEY_STEPS = 8;
const MAX_PICK_KEYS = 16;
/** In a `find` key: any element of the array at that point. */
const ANY_ELEMENT = '*';
/** The kinds of object step, by their one key. */
const OBJECT_STEPS = ['call', 'routeGroup', 'find', 'pick'] as const;

const ID = /^[a-z][a-z0-9_]{1,30}$/;
const SEMVER = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const ENTRY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const ATTRIBUTE = /^[A-Za-z_:][-A-Za-z0-9_:.]{0,63}$/;
const QUERY_PARAM = /^[A-Za-z0-9_.-]{1,64}$/;
const LABEL = /^[a-z0-9-]{1,63}$/;
const TOP_LEVEL_LABEL = /^[a-z]{2,63}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;
/** State-path steps that walk the prototype chain rather than the player's data. */
const PROTOTYPE_STEPS: readonly string[] = ['__proto__', 'prototype', 'constructor'];

/**
 * The zero-argument calls a module's state paths may make, per module id. The state-path
 * reader runs in the page's MAIN world and calls only a name listed here for the service it
 * reads: a call can do anything the page's code does, so each name is reviewed
 * here, outside the module's folder, with the module that needs it.
 */
export const ALLOWED_CALL_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // Netflix's player keeps its state behind `playerApp.getState()`.
  netflix: Object.freeze(['getState']),
});

/** A definition that is not valid, naming the field at fault. */
export class ServiceDefinitionError extends Error {
  override readonly name = 'ServiceDefinitionError';
  readonly serviceId: string | null;
  readonly field: string;

  constructor(serviceId: string | null, field: string, reason: string) {
    super(`service definition ${serviceId ?? '(no id)'}: ${field} ${reason}`);
    this.serviceId = serviceId;
    this.field = field;
  }
}

/** A bare domain: lower-case ASCII labels, at least two, an alphabetic last label. */
export function isBareDomain(host: string): boolean {
  if (host.length > MAX_HOST_LENGTH) return false;
  const labels = host.split('.');
  const last = labels[labels.length - 1];
  return (
    labels.length >= 2 &&
    last !== undefined &&
    TOP_LEVEL_LABEL.test(last) &&
    labels.every((label) => LABEL.test(label) && !label.startsWith('-') && !label.endsWith('-'))
  );
}

/** Days since the Unix epoch of a `YYYY-MM-DD` calendar date, read in UTC; `null` if not one. */
export function isoDay(text: string): number | null {
  const match = ISO_DATE.exec(text);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = Date.UTC(year, month - 1, day);
  const back = new Date(at);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  return at / DAY_MS;
}

/** `true` when `host` is `domain` itself or a subdomain of it — never a lookalike suffix. */
export function coversHost(domain: string, host: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The first player route that matches `pathname`, or `null`. A pathname over 2,048
 * characters never matches: routes are reviewed, not proven linear, so their input is
 * bounded instead.
 */
export function matchPlayerRoute(
  routes: readonly RegExp[],
  pathname: string,
): RegExpExecArray | null {
  if (pathname.length > MAX_ROUTE_INPUT) return null;
  for (const route of routes) {
    const match = route.exec(pathname);
    if (match !== null) return match;
  }
  return null;
}

/** Validates a module's definition in full and freezes it; throws `ServiceDefinitionError`. */
export function defineService(definition: ServiceDefinition): ServiceDefinition {
  new Validator(definition).run();
  return deepFreeze(definition);
}

const DEFINITION_KEYS = [
  'id',
  'name',
  'version',
  'hosts',
  'verified',
  'playerRoutes',
  'collect',
  'interpret',
] as const;
const COLLECT_KEYS = [
  'selectors',
  'jsonLd',
  'mediaSession',
  'openGraph',
  'queryParams',
  'pageState',
  'signals',
  'shadowRootPlayer',
] as const;

type Plain = Readonly<Record<string, unknown>>;

class Validator {
  private serviceId: string | null = null;
  private readonly definition: unknown;

  constructor(definition: unknown) {
    this.definition = definition;
  }

  run(): void {
    const d = this.plain(this.definition, '(definition)');
    const id = this.read(d, 'id', 'id');
    if (typeof id !== 'string' || !ID.test(id)) {
      this.fail('id', 'must match ^[a-z][a-z0-9_]{1,30}$');
    }
    this.serviceId = id;
    this.onlyKeys(d, DEFINITION_KEYS, '');

    const name = this.read(d, 'name', 'name');
    if (
      typeof name !== 'string' ||
      name.trim() === '' ||
      name.length > MAX_NAME_LENGTH ||
      CONTROL.test(name)
    ) {
      this.fail('name', `must be 1–${String(MAX_NAME_LENGTH)} printable characters`);
    }

    const version = this.read(d, 'version', 'version');
    if (typeof version !== 'string' || !SEMVER.test(version)) {
      this.fail('version', 'must be MAJOR.MINOR.PATCH');
    }

    this.hosts(this.read(d, 'hosts', 'hosts'));
    this.verified(this.read(d, 'verified', 'verified'));
    this.routes(this.read(d, 'playerRoutes', 'playerRoutes'));
    this.collect(this.read(d, 'collect', 'collect'), id);

    if (typeof this.read(d, 'interpret', 'interpret') !== 'function') {
      this.fail('interpret', 'must be a function');
    }
  }

  private fail(field: string, reason: string): never {
    throw new ServiceDefinitionError(this.serviceId, field, reason);
  }

  /** A plain object (an object literal), never an array or a class instance. */
  private plain(value: unknown, field: string): Plain {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(field, 'must be a plain object');
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) {
      this.fail(field, 'must be a plain object');
    }
    return value as Plain;
  }

  /** An own data property, read without running an accessor. */
  private read(object: Plain, key: string, field: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined) return undefined;
    if (!('value' in descriptor)) this.fail(field, 'must be a data property, not an accessor');
    return descriptor.value;
  }

  private onlyKeys(object: Plain, allowed: readonly string[], prefix: string): void {
    for (const key of Object.keys(object)) {
      if (!allowed.includes(key)) this.fail(`${prefix}${key}`, 'is not a known key');
    }
  }

  /**
   * An array's elements, each read as an own data property: an accessor is refused **without
   * being run**. `Array.prototype.map` would read every element through
   * `[[Get]]` first and run the getter before the refusal.
   */
  private list(value: unknown, field: string, min: number, max: number): readonly unknown[] {
    if (!Array.isArray(value)) this.fail(field, 'must be an array');
    const items = value as unknown as Plain;
    const length = (value as readonly unknown[]).length;
    if (length < min || length > max) {
      this.fail(field, `must hold ${String(min)}–${String(max)} entries`);
    }
    const elements: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      elements.push(this.read(items, String(index), `${field}[${String(index)}]`));
    }
    return elements;
  }

  private hosts(value: unknown): void {
    const hosts = this.list(value, 'hosts', 1, MAX_HOSTS);
    hosts.forEach((host, index) => {
      const field = `hosts[${String(index)}]`;
      if (typeof host !== 'string' || !isBareDomain(host)) {
        this.fail(field, 'must be a bare domain (lower-case ASCII, no scheme, port or path)');
      }
      if (isBlockedHost(host)) this.fail(field, 'is on the block list');
      for (const earlier of hosts.slice(0, index) as string[]) {
        if (coversHost(earlier, host) || coversHost(host, earlier)) {
          this.fail(field, `repeats or overlaps ${earlier}`);
        }
      }
    });
  }

  private verified(value: unknown): void {
    if (value === null) return;
    const verified = this.plain(value, 'verified');
    this.onlyKeys(verified, ['on', 'by'], 'verified.');
    const on = this.read(verified, 'on', 'verified.on');
    if (typeof on !== 'string' || isoDay(on) === null) {
      this.fail('verified.on', 'must be a calendar date, YYYY-MM-DD');
    }
    const by = this.read(verified, 'by', 'verified.by');
    if (
      typeof by !== 'string' ||
      by.trim() === '' ||
      by.length > MAX_VERIFIER_LENGTH ||
      CONTROL.test(by)
    ) {
      const most = String(MAX_VERIFIER_LENGTH);
      this.fail('verified.by', `must name who verified it in 1–${most} characters`);
    }
  }

  private routes(value: unknown): void {
    this.list(value, 'playerRoutes', 1, MAX_PLAYER_ROUTES).forEach((route, index) => {
      const field = `playerRoutes[${String(index)}]`;
      if (!(route instanceof RegExp)) this.fail(field, 'must be a RegExp');
      // A subclass or an own `exec` would run the module's code wherever a route is matched.
      if (
        Object.getPrototypeOf(route) !== RegExp.prototype ||
        Object.getOwnPropertyNames(route).some((key) => key !== 'lastIndex')
      ) {
        this.fail(field, 'must be a plain RegExp literal');
      }
      const problem = routeProblem(route);
      if (problem !== null) this.fail(field, problem);
    });
  }

  private collect(value: unknown, id: string): void {
    const collect = this.plain(value, 'collect');
    this.onlyKeys(collect, COLLECT_KEYS, 'collect.');
    for (const key of ['jsonLd', 'mediaSession', 'openGraph', 'shadowRootPlayer']) {
      const flag = this.read(collect, key, `collect.${key}`);
      if (flag !== undefined && flag !== true) {
        this.fail(`collect.${key}`, 'must be true or absent');
      }
    }
    const selectors = this.read(collect, 'selectors', 'collect.selectors');
    if (selectors !== undefined) this.selectors(selectors);
    const queryParams = this.read(collect, 'queryParams', 'collect.queryParams');
    if (queryParams !== undefined) this.queryParams(queryParams);
    const pageState = this.read(collect, 'pageState', 'collect.pageState');
    if (pageState !== undefined) this.pageState(pageState, id);
    const signals = this.read(collect, 'signals', 'collect.signals');
    if (signals !== undefined) this.signals(signals);
  }

  private css(value: unknown, field: string): void {
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.length > MAX_SELECTOR_LENGTH ||
      CONTROL.test(value)
    ) {
      this.fail(field, `must be a CSS selector of 1–${String(MAX_SELECTOR_LENGTH)} characters`);
    }
  }

  private entries(value: unknown, field: string, max: number): (readonly [string, unknown])[] {
    const object = this.plain(value, field);
    const names = Object.keys(object);
    if (names.length > max) this.fail(field, `must hold at most ${String(max)} entries`);
    return names.map((name) => {
      if (!ENTRY_NAME.test(name)) this.fail(`${field}.${name}`, 'must be an identifier name');
      return [name, this.read(object, name, `${field}.${name}`)] as const;
    });
  }

  private selectors(value: unknown): void {
    for (const [name, spec] of this.entries(value, 'collect.selectors', MAX_SELECTORS)) {
      const field = `collect.selectors.${name}`;
      const selector = this.plain(spec, field);
      this.onlyKeys(selector, ['css', 'attr', 'visibleOnly', 'max'], `${field}.`);
      this.css(this.read(selector, 'css', `${field}.css`), `${field}.css`);
      const attr = this.read(selector, 'attr', `${field}.attr`);
      if (attr !== undefined && (typeof attr !== 'string' || !ATTRIBUTE.test(attr))) {
        this.fail(`${field}.attr`, 'must be an attribute name');
      }
      const visibleOnly = this.read(selector, 'visibleOnly', `${field}.visibleOnly`);
      if (visibleOnly !== undefined && typeof visibleOnly !== 'boolean') {
        this.fail(`${field}.visibleOnly`, 'must be a boolean');
      }
      const max = this.read(selector, 'max', `${field}.max`);
      if (
        max !== undefined &&
        (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_SELECTOR_VALUES)
      ) {
        this.fail(`${field}.max`, `must be a whole number, 1 to ${String(MAX_SELECTOR_VALUES)}`);
      }
    }
  }

  private queryParams(value: unknown): void {
    const params = this.list(value, 'collect.queryParams', 0, MAX_QUERY_PARAMS);
    params.forEach((param, index) => {
      const field = `collect.queryParams[${String(index)}]`;
      if (typeof param !== 'string' || !QUERY_PARAM.test(param)) {
        this.fail(field, 'must be a query parameter name');
      }
      if (params.indexOf(param) !== index) this.fail(field, 'repeats an earlier entry');
    });
  }

  private pageState(value: unknown, id: string): void {
    const allowed = Object.hasOwn(ALLOWED_CALL_NAMES, id) ? (ALLOWED_CALL_NAMES[id] ?? []) : [];
    for (const [name, path] of this.entries(value, 'collect.pageState', MAX_STATE_PATHS)) {
      const field = `collect.pageState.${name}`;
      const steps = this.list(path, field, 1, MAX_STATE_PATH_STEPS);
      steps.forEach((step, index) => {
        const stepField = `${field}[${String(index)}]`;
        if (typeof step === 'string') {
          this.property(step, stepField);
          return;
        }
        if (index === 0) this.fail(stepField, 'must be a property; a path starts with no call');
        const object = this.plain(step, stepField);
        const kind = OBJECT_STEPS.find((key) => Object.hasOwn(object, key));
        if (kind === undefined) {
          this.fail(stepField, 'must be a property, a call, a route group, a find or a pick');
        }
        this.onlyKeys(object, [kind], `${stepField}.`);
        const stepValue = this.read(object, kind, `${stepField}.${kind}`);
        switch (kind) {
          case 'call':
            this.call(stepValue, `${stepField}.call`, allowed, id);
            return;
          case 'routeGroup':
            this.routeGroup(stepValue, `${stepField}.routeGroup`);
            return;
          case 'find':
            this.find(stepValue, `${stepField}.find`);
            return;
          case 'pick':
            if (index !== steps.length - 1) this.fail(stepField, 'must be the last step');
            this.pick(stepValue, `${stepField}.pick`);
            return;
        }
      });
    }
  }

  /** A property a state path reads: a plain name, never one that walks the prototype chain. */
  private property(step: unknown, field: string): void {
    if (
      typeof step !== 'string' ||
      step === '' ||
      step.length > MAX_STATE_PROPERTY_LENGTH ||
      CONTROL.test(step)
    ) {
      const most = String(MAX_STATE_PROPERTY_LENGTH);
      this.fail(field, `must be a property name of 1–${most} characters`);
    }
    if (PROTOTYPE_STEPS.includes(step)) this.fail(field, 'walks the prototype chain');
  }

  private call(callName: unknown, field: string, allowed: readonly string[], id: string): void {
    if (typeof callName !== 'string' || !IDENTIFIER.test(callName)) {
      this.fail(field, 'must be an identifier');
    }
    if (!allowed.includes(callName)) {
      this.fail(field, `is not in ALLOWED_CALL_NAMES for ${id}`);
    }
  }

  private routeGroup(group: unknown, field: string): void {
    if (
      typeof group !== 'number' ||
      !Number.isInteger(group) ||
      group < 1 ||
      group > MAX_ROUTE_GROUP
    ) {
      this.fail(field, `must name a capture group, 1 to ${String(MAX_ROUTE_GROUP)}`);
    }
  }

  private find(value: unknown, field: string): void {
    const find = this.plain(value, field);
    this.onlyKeys(find, ['key', 'routeGroup'], `${field}.`);
    const keyField = `${field}.key`;
    const key = this.list(this.read(find, 'key', keyField), keyField, 1, MAX_FIND_KEY_STEPS);
    key.forEach((step, index) => {
      if (step !== ANY_ELEMENT) this.property(step, `${field}.key[${String(index)}]`);
    });
    this.routeGroup(this.read(find, 'routeGroup', `${field}.routeGroup`), `${field}.routeGroup`);
  }

  private pick(value: unknown, field: string): void {
    const keys = this.list(value, field, 1, MAX_PICK_KEYS);
    keys.forEach((key, index) => {
      const keyField = `${field}[${String(index)}]`;
      this.property(key, keyField);
      if (keys.indexOf(key) !== index) this.fail(keyField, 'repeats an earlier entry');
    });
  }

  private signals(value: unknown): void {
    const signals = this.plain(value, 'collect.signals');
    this.onlyKeys(signals, ['endOfContent', 'adPlaying'], 'collect.signals.');
    for (const key of ['endOfContent', 'adPlaying']) {
      const css = this.read(signals, key, `collect.signals.${key}`);
      if (css !== undefined) this.css(css, `collect.signals.${key}`);
    }
  }
}

/** Freezes the definition's data (not its RegExps or its function), so validation holds. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || value instanceof RegExp) return value;
  for (const key of Object.keys(value)) {
    deepFreeze((value as Plain)[key]);
  }
  return Object.freeze(value);
}
