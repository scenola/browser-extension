/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { EXTENSION_OPERATIONS, extractSubset, mentionsHost, renderSubset } from './extract-subset';
import type { OpenApiDoc } from './extract-subset';

type JsonRecord = Record<string, unknown>;
interface ReceiptOperation {
  readonly parameters: readonly { in: string; name: string; schema: unknown }[];
}
const receiptOf = (doc: OpenApiDoc): ReceiptOperation =>
  (doc.paths?.['/v1/integrations/plays/{scrobble_id}'] as JsonRecord).get as ReceiptOperation;

// The backend repository is a sibling of this one: <parent>/extension/tools/openapi -> <parent>/backend.
const BACKEND_DOCUMENT = fileURLToPath(
  new URL('../../../backend/docs/ios/openapi.json', import.meta.url),
);
const present = existsSync(BACKEND_DOCUMENT);

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string) => ({ content: { 'application/json': { schema: ref(name) } } });
const VALIDATION_FAILED = {
  '422': { description: 'Validation Error', ...json('HTTPValidationError') },
};

/** A small document shaped like the backend's: three routes the extension calls, and more. */
function backendLike(): OpenApiDoc {
  return {
    openapi: '3.1.0',
    info: { title: 'Backend', version: '1.2.3', description: 'Everything the backend serves.' },
    servers: [{ url: 'https://api.staging.example.com' }],
    externalDocs: { url: 'https://docs.example.com' },
    security: [],
    tags: [
      { name: 'integrations', description: 'What a connected service calls.' },
      { name: 'admin', description: 'Operator routes.' },
    ],
    paths: {
      '/v1/integrations/oauth/token': {
        servers: [{ url: 'https://auth.internal' }],
        post: {
          operationId: 'exchangeIntegrationToken',
          tags: ['integrations'],
          parameters: [{ in: 'header', name: 'DPoP', schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': { schema: ref('Body_exchangeIntegrationToken') },
            },
            required: true,
          },
          responses: {
            '200': { description: 'Successful Response', ...json('IntegrationTokenResponse') },
            ...VALIDATION_FAILED,
          },
          externalDocs: { url: 'https://docs.example.com/token' },
          'x-internal-team': 'team-identity',
        },
      },
      '/v1/integrations/plays': {
        post: {
          operationId: 'reportIntegrationPlay',
          tags: ['integrations'],
          // A description that names a host is not published.
          description: 'Report a play. Internally proxied to plays.staging.example.com.',
          summary: 'Report Play',
          requestBody: { ...json('PlayEvidence'), required: true },
          responses: {
            '202': {
              description: 'Successful Response',
              ...json('PlayAcceptedResponse'),
              links: {
                receipt: {
                  operationId: 'getIntegrationPlay',
                  server: { url: 'https://receipts.internal' },
                },
              },
            },
            ...VALIDATION_FAILED,
          },
          security: [{ ScrobblerDpopCredential: [] }, { DpopProof: [] }],
        },
        // Another method on a kept path is not one of the extension's operations.
        get: {
          operationId: 'listIntegrationPlays',
          tags: ['admin'],
          responses: { '200': { description: 'ok', ...json('PlayList') } },
          security: [{ AdminSession: [] }],
        },
      },
      '/v1/integrations/plays/{scrobble_id}': {
        get: {
          operationId: 'getIntegrationPlay',
          tags: ['integrations'],
          parameters: [
            {
              in: 'path',
              name: 'scrobble_id',
              required: true,
              schema: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
            },
            {
              in: 'query',
              name: 'since',
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': { description: 'Successful Response', ...json('PlayReceiptResponse') },
            ...VALIDATION_FAILED,
          },
          security: [{ ScrobblerDpopCredential: [] }, { DpopProof: [] }],
        },
      },
      '/v1/integrations/connection': {
        get: {
          operationId: 'getIntegrationConnection',
          tags: ['integrations'],
          responses: {
            '200': { description: 'Successful Response', ...json('IntegrationConnectionResponse') },
          },
          security: [{ ScrobblerDpopCredential: [] }, { DpopProof: [] }],
        },
      },
      '/v1/admin/users': {
        get: {
          operationId: 'listUsers',
          tags: ['admin'],
          responses: { '200': { description: 'ok', ...json('AdminUser') } },
        },
      },
    },
    components: {
      schemas: {
        Body_exchangeIntegrationToken: {
          type: 'object',
          properties: { code: { type: 'string' } },
          required: ['code'],
        },
        IntegrationTokenResponse: {
          type: 'object',
          properties: { access_token: { type: 'string' } },
        },
        IntegrationConnectionResponse: {
          type: 'object',
          properties: { status: { type: 'string' }, expires_at: { type: 'string' } },
        },
        PlayEvidence: {
          type: 'object',
          description: 'One play as a source reported it.',
          externalDocs: { url: 'https://docs.example.com/plays' },
          properties: {
            ids: { anyOf: [ref('EvidenceIds'), { type: 'null' }] },
            show: { anyOf: [ref('ShowEvidence'), { type: 'null' }] },
            // Properties called `description` and `servers` are schemas, not prose or URLs.
            description: { type: 'string', description: 'Free text.' },
            servers: { type: 'array', items: { type: 'string' } },
          },
        },
        EvidenceIds: {
          type: 'object',
          properties: { provider: { type: 'array', items: ref('ProviderEvidence') } },
        },
        ShowEvidence: {
          type: 'object',
          properties: { ids: { anyOf: [ref('EvidenceIds'), { type: 'null' }] } },
        },
        ProviderEvidence: { type: 'object', properties: { value: { type: 'string' } } },
        PlayAcceptedResponse: { type: 'object', properties: { state: { type: 'string' } } },
        PlayReceiptResponse: {
          type: 'object',
          properties: { scrobble_id: { type: 'string', format: 'uuid' } },
        },
        HTTPValidationError: {
          type: 'object',
          properties: { detail: { type: 'array', items: ref('ValidationError') } },
        },
        ValidationError: { type: 'object', properties: { msg: { type: 'string' } } },
        PlayList: { type: 'array', items: ref('PlayReceiptResponse') },
        AdminUser: { type: 'object', properties: { email: { type: 'string' } } },
        Unreachable: { type: 'object' },
      },
      securitySchemes: {
        ScrobblerDpopCredential: { type: 'http', scheme: 'DPoP' },
        DpopProof: { type: 'apiKey', in: 'header', name: 'DPoP' },
        AdminSession: { type: 'apiKey', in: 'cookie', name: 'session' },
      },
    },
  };
}

const REACHED = [
  'Body_exchangeIntegrationToken',
  'EvidenceIds',
  'HTTPValidationError',
  'IntegrationConnectionResponse',
  'IntegrationTokenResponse',
  'PlayAcceptedResponse',
  'PlayEvidence',
  'PlayReceiptResponse',
  'ProviderEvidence',
  'ShowEvidence',
  'ValidationError',
];

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const operationsOf = (doc: OpenApiDoc): string[] =>
  Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item as object)
      .filter((k) => METHODS.includes(k))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );

/** Every string in a document, keys included. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out);
    }
  }
  return out;
}

/** The same document with every object's keys in reverse order. */
const reverseKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reverseKeys)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([k, v]) => [k, reverseKeys(v)]),
        )
      : value;

/** Every key of every object in a document. */
const keysOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keysOf)
    : value !== null && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)])
      : [];

describe('extractSubset', () => {
  test('the extension’s operations are exactly the four routes it calls', () => {
    expect(EXTENSION_OPERATIONS).toEqual([
      'POST /v1/integrations/oauth/token',
      'POST /v1/integrations/plays',
      'GET /v1/integrations/plays/{scrobble_id}',
      'GET /v1/integrations/connection',
    ]);
  });

  test('keeps only the named operations and the schemas they reach, transitively', () => {
    const subset = extractSubset(backendLike(), EXTENSION_OPERATIONS);
    expect(operationsOf(subset).sort()).toEqual([...EXTENSION_OPERATIONS].sort());
    expect(Object.keys(subset.paths ?? {})).not.toContain('/v1/admin/users');
    expect(Object.keys(subset.components?.schemas ?? {}).sort()).toEqual(REACHED);
    // Only the security schemes a kept operation names.
    expect(Object.keys(subset.components?.securitySchemes ?? {}).sort()).toEqual([
      'DpopProof',
      'ScrobblerDpopCredential',
    ]);
    expect(subset.tags).toEqual([{ name: 'integrations' }]);
  });

  test('publishes nothing else: no servers, external docs, extensions or backend description', () => {
    const subset = extractSubset(backendLike(), EXTENSION_OPERATIONS);
    const keys = keysOf(subset);
    expect(keys).not.toContain('externalDocs');
    expect(keys).not.toContain('server');
    expect(keys.filter((k) => k.startsWith('x-'))).toEqual([]);
    expect(subset.servers).toBeUndefined();
    expect((subset.paths?.['/v1/integrations/oauth/token'] as JsonRecord).servers).toBeUndefined();
    const report = (subset.paths?.['/v1/integrations/plays'] as JsonRecord).post as JsonRecord;
    expect(report.responses).toMatchObject({
      '202': { links: { receipt: { operationId: 'getIntegrationPlay' } } },
    });
    // A property called `servers` is a schema; only Server Objects are dropped.
    const play = subset.components?.schemas?.PlayEvidence as JsonRecord;
    expect((play.properties as JsonRecord).servers).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    expect(subset.info).toEqual({
      title: 'Scenola API',
      version: '1.2.3',
      description: expect.stringContaining('pnpm openapi:sync') as unknown,
    });
    expect(strings(subset).some((s) => s.includes('Everything the backend serves'))).toBe(false);
    expect(strings(subset).filter((s) => mentionsHost(s))).toEqual([]);
  });

  test('no prose is published, but a property called `description` is a schema and stays', () => {
    const subset = extractSubset(backendLike(), EXTENSION_OPERATIONS);
    const report = (subset.paths?.['/v1/integrations/plays'] as Record<string, unknown>)
      .post as Record<string, unknown>;
    expect(report.description).toBeUndefined();
    expect(report.summary).toBeUndefined();
    const play = subset.components?.schemas?.PlayEvidence as Record<string, unknown>;
    expect(play.description).toBeUndefined();
    expect((play.properties as Record<string, unknown>).description).toEqual({ type: 'string' });
    // A Response Object's description is required by OpenAPI: kept, empty.
    expect(report.responses).toMatchObject({ '202': { description: '' } });
    expect(strings(subset).filter((s) => /Successful Response|Free text/u.test(s))).toEqual([]);
  });

  test('a path parameter loses `format: uuid` (the 202 names a play by a 26-character id)', () => {
    const subset = extractSubset(backendLike(), EXTENSION_OPERATIONS);
    const [path, query] = receiptOf(subset).parameters;
    expect(path?.schema).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    // Only path parameters are relaxed; a schema's own format is the backend's statement.
    expect(query?.schema).toEqual({ type: 'string', format: 'uuid' });
    const receiptSchema = subset.components?.schemas?.PlayReceiptResponse as JsonRecord;
    expect(receiptSchema.properties).toEqual({ scrobble_id: { type: 'string', format: 'uuid' } });
  });

  test('canonical and pure: sorted keys, the same output twice, the input untouched', () => {
    const input = backendLike();
    const before = JSON.stringify(input);
    const first = renderSubset(extractSubset(input, EXTENSION_OPERATIONS));
    expect(JSON.stringify(input)).toBe(before);
    expect(renderSubset(extractSubset(input, EXTENSION_OPERATIONS))).toBe(first);
    // The order of the backend's keys does not matter.
    const reordered = reverseKeys(input) as OpenApiDoc;
    expect(JSON.stringify(reordered)).not.toBe(before);
    expect(renderSubset(extractSubset(reordered, EXTENSION_OPERATIONS))).toBe(first);
    const sorted = (value: unknown): boolean =>
      Array.isArray(value)
        ? value.every(sorted)
        : value === null || typeof value !== 'object'
          ? true
          : Object.keys(value).join('\u0000') === Object.keys(value).sort().join('\u0000') &&
            Object.values(value).every(sorted);
    expect(sorted(JSON.parse(first))).toBe(true);
    expect(first.endsWith('}\n')).toBe(true);
  });

  test('a schema cycle is followed once and terminates', () => {
    const doc = backendLike();
    const schemas = doc.components?.schemas as Record<string, unknown>;
    schemas.EvidenceIds = { type: 'object', properties: { parent: ref('ShowEvidence') } };
    const subset = extractSubset(doc, EXTENSION_OPERATIONS);
    expect(Object.keys(subset.components?.schemas ?? {})).toContain('ShowEvidence');
  });

  test('a discriminator mapping reaches its schemas, by pointer or by bare name', () => {
    const doc = backendLike();
    const schemas = doc.components?.schemas as Record<string, unknown>;
    schemas.PlayAcceptedResponse = {
      oneOf: [ref('Accepted')],
      discriminator: {
        propertyName: 'state',
        mapping: { accepted: '#/components/schemas/Accepted', held: 'Held' },
      },
    };
    schemas.Accepted = { type: 'object' };
    schemas.Held = { type: 'object' };
    const names = Object.keys(extractSubset(doc, EXTENSION_OPERATIONS).components?.schemas ?? {});
    expect(names).toContain('Accepted');
    expect(names).toContain('Held');
  });

  test('fails loudly on what it cannot honour', () => {
    const missing = backendLike();
    delete (missing.paths as Record<string, unknown>)['/v1/integrations/oauth/token'];
    expect(() => extractSubset(missing, EXTENSION_OPERATIONS)).toThrow(
      /POST \/v1\/integrations\/oauth\/token/u,
    );

    expect(() => extractSubset(backendLike(), ['FETCH /v1/x'])).toThrow(/operation/u);
    expect(() => extractSubset(backendLike(), ['DELETE /v1/integrations/plays'])).toThrow(
      /DELETE \/v1\/integrations\/plays/u,
    );

    const dangling = backendLike();
    delete (dangling.components?.schemas as Record<string, unknown>).ShowEvidence;
    expect(() => extractSubset(dangling, EXTENSION_OPERATIONS)).toThrow(/ShowEvidence/u);

    const external = backendLike();
    (external.components?.schemas as Record<string, unknown>).ProviderEvidence = {
      $ref: 'https://schemas.example.com/provider.json',
    };
    expect(() => extractSubset(external, EXTENSION_OPERATIONS)).toThrow(/\$ref/u);

    // A host anywhere but in prose cannot be dropped silently: the extraction refuses.
    const example = backendLike();
    (example.components?.schemas as Record<string, unknown>).ProviderEvidence = {
      type: 'object',
      example: { value: 'http://10.0.0.7:8000/v1/plays' },
    };
    expect(() => extractSubset(example, EXTENSION_OPERATIONS)).toThrow(/host/u);

    const notPaths = [] as unknown as JsonRecord;
    const listed = { ...backendLike(), paths: notPaths };
    expect(() => extractSubset(listed, EXTENSION_OPERATIONS)).toThrow(/paths/u);
  });
});

describe('mentionsHost', () => {
  test('a URL, localhost, an IP address or a host name is a mention', () => {
    for (const text of [
      'see https://example.org/x',
      'served from localhost:8000',
      'proxied at 10.0.0.7',
      'the box db.cluster.internal answers',
      'call api.scenola.com.',
      'ws://realtime',
      'Mixed CASE: API.Example.COM',
    ]) {
      expect(mentionsHost(text), text).toBe(true);
    }
  });

  test('prose, ids, file names and version numbers are not', () => {
    for (const text of [
      'One play as a source reported it (section 4.3).',
      '``{namespace: "provider.netflix", key: "contentId"}``',
      'See plays.md and app/example/matching.py, RFC 9449 §8, section 4.2.',
      'e.g. a token, i.e. a credential',
      'version 1.2.3 and 26.6.5',
      'the web app.',
      '',
    ]) {
      expect(mentionsHost(text), text).toBe(false);
    }
  });

  test('linear on a long run of labels with no host in it', () => {
    const long = `${'a.'.repeat(200_000)}a`;
    const started = performance.now();
    expect(mentionsHost(long)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

const SUBSET_FILE = fileURLToPath(new URL('./openapi.subset.json', import.meta.url));

const isRecord = (v: unknown): v is JsonRecord =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The objects in which OpenAPI gives `servers` and `externalDocs` their meaning — the root,
 * each path item, each operation — with their JSON pointers. Anywhere else (a schema's
 * `properties`, say) a key of that name is a name, not a server.
 */
function serverHolders(doc: OpenApiDoc): [string, JsonRecord][] {
  const holders: [string, JsonRecord][] = [['/', doc]];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!isRecord(item)) continue;
    const at = `/paths/${pointerKey(path)}`;
    holders.push([at, item]);
    for (const method of METHODS) {
      const operation = item[method];
      if (isRecord(operation)) holders.push([`${at}/${method}`, operation]);
    }
  }
  return holders;
}

const pointerKey = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * Every vendor extension (`x-…`) in `value`, as `[key, pointer of its object]` — every key but
 * a schema's property names (the keys of a `properties` map), which are names, not keywords;
 * the property schemas themselves are still searched.
 */
function extensionsIn(value: unknown, at = '', names = false): [string, string][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => extensionsIn(item, `${at}/${String(i)}`));
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, inner]): [string, string][] => [
    ...(!names && key.startsWith('x-') ? [[key, at === '' ? '/' : at] as [string, string]] : []),
    ...extensionsIn(inner, `${at}/${pointerKey(key)}`, !names && key === 'properties'),
  ]);
}

/**
 * What is wrong with a committed subset's text, as messages (none when it is sound): not the
 * extension's operations exactly, not what `renderSubset` writes for it (a hand edit, or a
 * renderer that changed without a sync), a server or external docs where OpenAPI reads one, a
 * vendor extension where OpenAPI reads one, or a host named anywhere. The half of
 * `pnpm openapi:check` that needs no backend checkout.
 */
function committedSubsetProblems(text: string): string[] {
  let doc: OpenApiDoc;
  try {
    doc = JSON.parse(text) as OpenApiDoc;
  } catch {
    return ['not JSON'];
  }
  const problems: string[] = [];
  const operations = operationsOf(doc).sort();
  if (JSON.stringify(operations) !== JSON.stringify([...EXTENSION_OPERATIONS].sort())) {
    problems.push(`operations: ${operations.join(', ')}`);
  }
  if (renderSubset(doc) !== text) problems.push('not as renderSubset writes it');
  for (const [at, holder] of serverHolders(doc)) {
    for (const key of ['servers', 'externalDocs']) {
      if (holder[key] !== undefined) problems.push(`has ${key} at ${at}`);
    }
  }
  for (const [key, at] of extensionsIn(doc)) problems.push(`has vendor extension ${key} at ${at}`);
  if (strings(doc).some((s) => mentionsHost(s))) problems.push('names a host');
  return problems;
}

describe('the committed subset, with or without the backend', () => {
  test('is the extension’s operations, as renderSubset writes them, with no server and no host', async () => {
    expect(committedSubsetProblems(await readFile(SUBSET_FILE, 'utf8'))).toEqual([]);
  });

  test('the check fires on each way a hand edit breaks it', async () => {
    const text = await readFile(SUBSET_FILE, 'utf8');
    const doc = JSON.parse(text) as JsonRecord;
    const asText = (d: unknown): string => `${JSON.stringify(d, null, 2)}\n`;
    const paths = doc.paths as JsonRecord;

    const extra = structuredClone(doc);
    (extra.paths as JsonRecord)['/v1/me'] = { get: { responses: {} } };
    // The extension's four operations and one more.
    expect(committedSubsetProblems(renderSubset(extra as OpenApiDoc))).toEqual([
      'operations: GET /v1/integrations/connection, GET /v1/integrations/plays/{scrobble_id}, ' +
        'GET /v1/me, POST /v1/integrations/oauth/token, POST /v1/integrations/plays',
    ]);
    const missing = { ...doc, paths: { ...paths } };
    delete missing.paths['/v1/integrations/oauth/token'];
    expect(committedSubsetProblems(renderSubset(missing as OpenApiDoc))[0]).toMatch(/^operations/);

    expect(committedSubsetProblems(text.replaceAll('  ', '    '))).toEqual([
      'not as renderSubset writes it',
    ]);
    expect(committedSubsetProblems(text.trimEnd())).toEqual(['not as renderSubset writes it']);
    expect(committedSubsetProblems('{')).toEqual(['not JSON']);

    // Each of these renderSubset would drop or refuse, so the text is also not its rendering.
    expect(
      committedSubsetProblems(asText({ ...doc, servers: [{ url: 'https://api.example.com' }] })),
    ).toEqual(['not as renderSubset writes it', 'has servers at /', 'names a host']);
    expect(
      committedSubsetProblems(asText({ ...doc, externalDocs: { url: 'https://docs.example' } })),
    ).toEqual(['not as renderSubset writes it', 'has externalDocs at /', 'names a host']);
    // Where OpenAPI reads them: a path item, an operation — a relative URL names no host.
    const plays = paths['/v1/integrations/plays'] as JsonRecord;
    const atOperation = structuredClone(doc);
    (atOperation.paths as JsonRecord)['/v1/integrations/plays'] = {
      ...plays,
      servers: [{ url: '/v2' }],
      post: { ...(plays.post as JsonRecord), externalDocs: { url: '/docs' } },
    };
    expect(committedSubsetProblems(asText(atOperation))).toEqual([
      'not as renderSubset writes it',
      'has servers at /paths/~1v1~1integrations~1plays',
      'has externalDocs at /paths/~1v1~1integrations~1plays/post',
    ]);
    expect(committedSubsetProblems(asText({ ...doc, 'x-team': 'team' }))).toContain(
      'has vendor extension x-team at /',
    );
    // On a schema (a keyword there, which renderSubset keeps): only this check sees it.
    const onSchema = structuredClone(doc);
    const schemas = (onSchema.components as JsonRecord).schemas as JsonRecord;
    schemas.PlayEvidence = { ...(schemas.PlayEvidence as JsonRecord), 'x-internal': true };
    expect(committedSubsetProblems(renderSubset(onSchema as OpenApiDoc))).toEqual([
      'has vendor extension x-internal at /components/schemas/PlayEvidence',
    ]);
    const info = { ...(doc.info as JsonRecord), description: 'Served from localhost:8000.' };
    expect(committedSubsetProblems(asText({ ...doc, info }))).toContain('names a host');
  });

  test('a schema property called servers, externalDocs or x-… is a name, not a keyword: it passes', async () => {
    const doc = JSON.parse(await readFile(SUBSET_FILE, 'utf8')) as JsonRecord;
    const schemas = (doc.components as JsonRecord).schemas as JsonRecord;
    const evidence = schemas.PlayEvidence as JsonRecord;
    const named = structuredClone(doc);
    ((named.components as JsonRecord).schemas as JsonRecord).PlayEvidence = {
      ...evidence,
      properties: {
        ...(evidence.properties as JsonRecord),
        servers: { type: 'array', items: { type: 'string' } },
        externalDocs: { type: 'string' },
        'x-legacy': { type: 'boolean' },
      },
    };
    const text = renderSubset(named as OpenApiDoc);
    expect(text).toContain('"servers"');
    expect(text).toContain('"x-legacy"');
    expect(committedSubsetProblems(text)).toEqual([]);
  });

  test('an x- key inside a property’s own schema is a keyword again: it fires', async () => {
    const doc = JSON.parse(await readFile(SUBSET_FILE, 'utf8')) as JsonRecord;
    const schemas = (doc.components as JsonRecord).schemas as JsonRecord;
    const evidence = schemas.PlayEvidence as JsonRecord;
    const nested = structuredClone(doc);
    ((nested.components as JsonRecord).schemas as JsonRecord).PlayEvidence = {
      ...evidence,
      properties: {
        ...(evidence.properties as JsonRecord),
        'x-legacy': { type: 'boolean', 'x-internal': true },
      },
    };
    expect(committedSubsetProblems(renderSubset(nested as OpenApiDoc))).toEqual([
      'has vendor extension x-internal at /components/schemas/PlayEvidence/properties/x-legacy',
    ]);
  });
});

describe('the backend’s own document', () => {
  test.skipIf(!present)(
    `keeps the four operations and no servers (${BACKEND_DOCUMENT})`,
    async () => {
      const spec = JSON.parse(await readFile(BACKEND_DOCUMENT, 'utf8')) as OpenApiDoc;
      const subset = extractSubset(spec, EXTENSION_OPERATIONS);
      expect(operationsOf(subset).sort()).toEqual([...EXTENSION_OPERATIONS].sort());
      expect(keysOf(subset)).not.toContain('servers');
      expect(Object.keys(subset.components?.schemas ?? {}).sort()).toEqual(REACHED);
      expect(strings(subset).filter((s) => mentionsHost(s))).toEqual([]);
      const id = receiptOf(subset).parameters.find((p) => p.in === 'path');
      expect(id?.name).toBe('scrobble_id');
      expect(JSON.stringify(id)).not.toContain('"format":"uuid"');
    },
  );

  test.skipIf(present)(`backend repo not found at ${BACKEND_DOCUMENT}: subset not checked`, () => {
    // Skipped on purpose when the sibling backend checkout is absent.
  });
});
