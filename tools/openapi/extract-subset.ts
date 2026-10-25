/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The part of Scenola's API document this public repository may hold: the routes the
// extension calls and what they reach, nothing else. Pure: a document in,
// a document out; `sync.ts` does the reading and writing.

/** An OpenAPI 3.x document, as far as the extraction needs to know one. */
export interface OpenApiDoc {
  readonly openapi: string;
  readonly info: Readonly<Record<string, unknown>>;
  readonly paths?: Readonly<Record<string, unknown>>;
  readonly components?: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>;
  readonly tags?: readonly unknown[];
  readonly security?: readonly unknown[];
  readonly [key: string]: unknown;
}

/** The operations the extension calls, as `METHOD /path`. */
export const EXTENSION_OPERATIONS = [
  'POST /v1/integrations/oauth/token',
  'POST /v1/integrations/plays',
  'GET /v1/integrations/plays/{scrobble_id}',
  'GET /v1/integrations/connection',
] as const;

// The subset names itself rather than taking the backend's title, so the product's name here
// does not wait on the backend's.
const SUBSET_TITLE = 'Scenola API';

const SUBSET_NOTE =
  'The routes the Scenola extension calls, extracted from the backend’s API document by ' +
  '`tools/openapi/extract-subset.ts`. Generated: change it with `pnpm openapi:sync`, never by hand.';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
type Method = (typeof METHODS)[number];

// What is kept of each object is listed, never what is dropped: anything the backend adds
// later (`servers`, `externalDocs`, `callbacks`, `x-…`) stays out until it is listed here.
const PATH_ITEM_KEYS = ['summary', 'description', 'parameters'] as const;
const OPERATION_KEYS = [
  'operationId',
  'summary',
  'description',
  'tags',
  'parameters',
  'requestBody',
  'responses',
  'security',
  'deprecated',
] as const;
const TAG_KEYS = ['name', 'description'] as const;
const COMPONENT_KINDS = new Set([
  'schemas',
  'responses',
  'parameters',
  'examples',
  'requestBodies',
  'headers',
  'securitySchemes',
  'links',
  'callbacks',
  'pathItems',
]);
/**
 * Prose is never published. The backend's descriptions explain its own internals, which this
 * repository neither holds nor needs: the subset is the contract — names, shapes and statuses —
 * and the client's own code says what it does with them.
 */
const PROSE_KEYS = new Set(['description', 'summary']);

/** The JSON pointer of a Response Object: a status's entry in an operation's `responses`. */
const RESPONSE_OBJECT = /\/responses\/[^/]+$/u;

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isUrlObject = (v: unknown): boolean => isObject(v) && typeof v.url === 'string';

/**
 * An OpenAPI field that is a URL by its shape, wherever it sits: `servers` (Server Objects),
 * `externalDocs` (an External Documentation Object) and a Link's `server`. Removed at any
 * depth. Judged by the value, not the name alone, so a schema *property* called `servers`
 * (a schema, not a list of URLs) stays.
 */
function isUrlField(key: string, v: unknown): boolean {
  if (key === 'servers') return Array.isArray(v) && v.every(isUrlObject);
  if (key === 'externalDocs' || key === 'server') return isUrlObject(v);
  return false;
}

function objectAt(v: unknown, where: string): JsonObject {
  if (!isObject(v)) throw new TypeError(`extractSubset: ${where} is not an object`);
  return v;
}

/** `METHOD /path` → its parts; anything else is refused. */
function parseOperation(selector: string): { readonly method: Method; readonly path: string } {
  const match = /^([A-Z]+) (\/\S*)$/u.exec(selector);
  const method = match?.[1]?.toLowerCase();
  const path = match?.[2];
  if (
    method === undefined ||
    path === undefined ||
    !(METHODS as readonly string[]).includes(method)
  ) {
    throw new TypeError(`extractSubset: "${selector}" is not an operation ("METHOD /path")`);
  }
  return { method: method as Method, path };
}

function pick(source: JsonObject, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = structuredClone(source[key]);
  return out;
}

/** A schema without `format: uuid`, in itself and in its `anyOf`/`oneOf`/`allOf` branches. */
function withoutUuidFormat(schema: unknown): void {
  const stack: unknown[] = [schema];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (!isObject(next)) continue;
    if (next.format === 'uuid') delete next.format;
    for (const branch of ['anyOf', 'oneOf', 'allOf']) {
      const list = next[branch];
      if (Array.isArray(list)) for (const item of list) stack.push(item);
    }
  }
}

/**
 * The backend's ids on the wire are 26-character Crockford strings (the `202`'s
 * `scrobble_id`), and the server accepts them in a path whatever the document says; a path
 * parameter typed `format: uuid` would make a validating client refuse its own ids
 * (the play receipt route). Only path parameters are relaxed.
 */
function relaxPathParameters(parameters: unknown): void {
  if (!Array.isArray(parameters)) return;
  for (const p of parameters) if (isObject(p) && p.in === 'path') withoutUuidFormat(p.schema);
}

/** `#/components/<kind>/<name>` → `[kind, name]`; anything else is refused. */
function componentOf(pointer: string): readonly [string, string] {
  const match = /^#\/components\/([A-Za-z]+)\/([^/]+)$/u.exec(pointer);
  const kind = match?.[1];
  const name = match?.[2]?.replaceAll('~1', '/').replaceAll('~0', '~');
  if (kind === undefined || name === undefined || !COMPONENT_KINDS.has(kind)) {
    throw new TypeError(`extractSubset: $ref "${pointer}" is not a local component`);
  }
  return [kind, name];
}

/** Every component pointer directly inside `value`: `$ref`s and discriminator mappings. */
function pointersIn(value: unknown): string[] {
  const found: string[] = [];
  const stack: unknown[] = [value];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (Array.isArray(next)) {
      for (const item of next) stack.push(item);
      continue;
    }
    if (!isObject(next)) continue;
    for (const [key, v] of Object.entries(next)) {
      if (key === '$ref' && typeof v === 'string') found.push(v);
      else {
        if (key === 'discriminator') found.push(...mappingTargets(v));
        stack.push(v);
      }
    }
  }
  return found;
}

/** A discriminator's mapping targets as pointers: a bare schema name is a schema's. */
function mappingTargets(discriminator: unknown): string[] {
  if (!isObject(discriminator) || !isObject(discriminator.mapping)) return [];
  return Object.values(discriminator.mapping)
    .filter((target): target is string => typeof target === 'string')
    .map((target) => (target.startsWith('#') ? target : `#/components/schemas/${target}`));
}

/** The security scheme names an operation's (or the document's) requirements use. */
function schemeNames(security: unknown): string[] {
  if (!Array.isArray(security)) return [];
  return security.filter(isObject).flatMap((requirement) => Object.keys(requirement));
}

const TLDS = new Set([
  'com',
  'net',
  'org',
  'io',
  'dev',
  'app',
  'cloud',
  'eu',
  'de',
  'uk',
  'co',
  'info',
  'biz',
  'xyz',
  'me',
  'tech',
  'site',
  'online',
  'host',
  'internal',
  'local',
  'localdomain',
  'lan',
  'home',
  'corp',
  'intranet',
  'private',
  'test',
  'example',
  'invalid',
  'svc',
  'cluster',
]);
const LABEL = /^[a-z0-9-]+$/u;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const IPV6 = /^\[?[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\]?$/iu;

/** A sentence's full stop is not part of the host before it. (A loop: `/\.+$/` is quadratic.) */
function withoutTrailingDots(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '.') end -= 1;
  return s.slice(0, end);
}

/**
 * The text names a place on a network: a URL, `localhost`, an IP address, or a host name
 * ending in a common or infrastructure top-level domain. Over-matching only drops prose, so
 * the rule leans that way. Linear: one split, then a constant amount of work per token.
 */
export function mentionsHost(text: string): boolean {
  if (text.includes('://')) return true;
  for (const token of text.split(/[^A-Za-z0-9.:/_[\]-]+/u)) {
    if (token === '') continue;
    const lower = token.toLowerCase();
    if (lower.includes('localhost')) return true;
    if (lower.includes('::') && IPV6.test(lower)) return true;
    const host = withoutTrailingDots(lower.split(/[/:]/u, 1)[0] ?? '');
    if (IPV4.test(host)) return true;
    const labels = host.split('.');
    const tld = labels[labels.length - 1];
    if (
      labels.length >= 2 &&
      tld !== undefined &&
      TLDS.has(tld) &&
      labels.every((l) => LABEL.test(l))
    ) {
      return true;
    }
  }
  return false;
}

const refuseHost = (at: string): never => {
  throw new TypeError(`extractSubset: ${at || '/'} names a host; it cannot be published`);
};

/**
 * `value` as it may be published, with every object's keys in code-unit order (so the output
 * does not depend on the input's order): without a URL field (`isUrlField`) at any depth,
 * and without prose (a `description` or `summary` string) — except a Response Object's
 * `description`, which OpenAPI requires, published empty. A host named anywhere else
 * (a URL in an example, a default, a pattern, a key) refuses the subset: that is not prose
 * to drop but contract to look at. `at` is the JSON pointer, for the message.
 */
function published(value: unknown, at = ''): unknown {
  if (Array.isArray(value)) return value.map((item, i) => published(item, `${at}/${String(i)}`));
  if (!isObject(value)) {
    if (typeof value === 'string' && mentionsHost(value)) refuseHost(at);
    return value;
  }
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    const here = `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (isUrlField(key, v)) continue;
    if (PROSE_KEYS.has(key) && typeof v === 'string') {
      if (key === 'description' && RESPONSE_OBJECT.test(at)) out[key] = '';
      continue;
    }
    if (mentionsHost(key)) refuseHost(here);
    out[key] = published(v, here);
  }
  return out;
}

/**
 * `spec` cut down to `operations` (`METHOD /path`, every one of which must exist) and the
 * components they reach transitively, with the security schemes and tags they name. No
 * `servers`, no `externalDocs`, no vendor extension, no prose; a host named outside prose
 * refuses the subset. A path
 * parameter's `format: uuid` is removed (`relaxPathParameters`). Throws on what it cannot
 * honour: a missing operation, a `$ref` that is not a local component or names a missing
 * one. Canonical: the same input in any key order gives the same output. `spec` is not
 * changed.
 */
export function extractSubset(spec: OpenApiDoc, operations: readonly string[]): OpenApiDoc {
  if (typeof spec.openapi !== 'string' || !spec.openapi.startsWith('3.')) {
    throw new TypeError('extractSubset: not an OpenAPI 3 document');
  }
  const info = objectAt(spec.info, 'info');
  if (typeof info.title !== 'string' || typeof info.version !== 'string') {
    throw new TypeError('extractSubset: info has no title or version');
  }
  const paths = keptPaths(objectAt(spec.paths, 'paths'), operations);
  const sourceComponents = spec.components ?? {};
  const components = reachedComponents(paths, sourceComponents);
  const keptOperations = Object.values(paths).flatMap((item) =>
    METHODS.map((m) => item[m]).filter(isObject),
  );
  const securitySchemes = schemesUsed(spec, keptOperations, sourceComponents);
  if (Object.keys(securitySchemes).length > 0) components.securitySchemes = securitySchemes;
  const tags = tagsUsed(spec, keptOperations);

  const subset: JsonObject = {
    openapi: spec.openapi,
    info: { title: SUBSET_TITLE, version: info.version, description: SUBSET_NOTE },
    paths,
    ...(Object.keys(components).length > 0 ? { components } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(Array.isArray(spec.security) ? { security: structuredClone(spec.security) } : {}),
  };
  return withNote(published(subset) as OpenApiDoc);
}

/** The path items of `operations`, each operation and item cut to the keys a subset keeps. */
function keptPaths(
  sourcePaths: JsonObject,
  operations: readonly string[],
): Record<string, JsonObject> {
  const paths: Record<string, JsonObject> = {};
  for (const selector of operations) {
    const { method, path } = parseOperation(selector);
    const item = sourcePaths[path];
    const operation = isObject(item) ? item[method] : undefined;
    if (!isObject(item) || !isObject(operation)) {
      throw new TypeError(`extractSubset: the document has no ${selector}`);
    }
    if (item.$ref !== undefined || operation.$ref !== undefined) {
      throw new TypeError(`extractSubset: ${selector} is a $ref; resolve it in the source first`);
    }
    const kept = (paths[path] ??= pick(item, PATH_ITEM_KEYS));
    const copy = pick(operation, OPERATION_KEYS);
    relaxPathParameters(kept.parameters);
    relaxPathParameters(copy.parameters);
    kept[method] = copy;
  }
  return paths;
}

/** The components the kept operations reach, followed through each other, each once. */
function reachedComponents(
  paths: Record<string, JsonObject>,
  sourceComponents: NonNullable<OpenApiDoc['components']>,
): Record<string, JsonObject> {
  const components: Record<string, JsonObject> = {};
  const seen = new Set<string>();
  const pending = pointersIn(paths);
  for (let pointer = pending.pop(); pointer !== undefined; pointer = pending.pop()) {
    if (seen.has(pointer)) continue;
    seen.add(pointer);
    const [kind, name] = componentOf(pointer);
    const found = sourceComponents[kind]?.[name];
    if (found === undefined) {
      throw new TypeError(`extractSubset: $ref "${pointer}" names no component (${name})`);
    }
    const copy = structuredClone(found);
    if (kind === 'parameters' && isObject(copy) && copy.in === 'path') {
      withoutUuidFormat(copy.schema);
    }
    (components[kind] ??= {})[name] = copy;
    for (const inner of pointersIn(copy)) pending.push(inner);
  }
  return components;
}

/** The security schemes the document's and the kept operations' requirements name. */
function schemesUsed(
  spec: OpenApiDoc,
  keptOperations: readonly JsonObject[],
  sourceComponents: NonNullable<OpenApiDoc['components']>,
): JsonObject {
  const schemes = new Set([
    ...schemeNames(spec.security),
    ...keptOperations.flatMap((op) => schemeNames(op.security)),
  ]);
  const securitySchemes: JsonObject = {};
  for (const name of schemes) {
    const scheme = sourceComponents.securitySchemes?.[name];
    if (scheme === undefined) {
      throw new TypeError(`extractSubset: security scheme "${name}" is not in the document`);
    }
    securitySchemes[name] = structuredClone(scheme);
  }
  return securitySchemes;
}

/** The document's tags the kept operations use, each cut to the keys a subset keeps. */
function tagsUsed(spec: OpenApiDoc, keptOperations: readonly JsonObject[]): JsonObject[] {
  const tagNames = new Set(
    keptOperations.flatMap((op) =>
      Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === 'string') : [],
    ),
  );
  return (Array.isArray(spec.tags) ? spec.tags : [])
    .filter(isObject)
    .filter((t) => typeof t.name === 'string' && tagNames.has(t.name))
    .map((t) => pick(t, TAG_KEYS));
}

/** The subset's own title and note, the one piece of prose it carries: where it came from. */
function withNote(subset: OpenApiDoc): OpenApiDoc {
  const info: JsonObject = {
    ...objectAt(subset.info, 'info'),
    title: SUBSET_TITLE,
    description: SUBSET_NOTE,
  };
  // Keys stay in code-unit order, as everywhere else in the subset.
  const sorted = Object.fromEntries(
    Object.keys(info)
      .sort()
      .map((key) => [key, info[key]]),
  );
  return { ...subset, info: sorted };
}

/** The subset as it is committed: canonical two-space JSON and a final newline. */
export function renderSubset(subset: OpenApiDoc): string {
  return `${JSON.stringify(withNote(published(subset) as OpenApiDoc), null, 2)}\n`;
}
