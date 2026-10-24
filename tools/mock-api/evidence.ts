/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Request validation as the server's: the subset's own schemas (`tools/openapi/
// openapi.subset.json`, what `pnpm openapi:sync` copies from the backend) compiled into
// validators, plus what the backend's model checks beyond its schema
// (a `watched_at` with an offset, at least one identifying field) and the 422 envelope's lean
// entries.
//
// A schema keyword this compiler does not implement is refused when the module loads: a subset
// that gains one (`exclusiveMinimum`, a new `format`) stops the mock from starting rather than
// letting it accept what the server refuses.
//
// Where the server is lax it is matched only as far as is safe. Pydantic's lax mode takes `"5"` or
// `true` for an integer, `"true"` or `1` for a boolean and a number for `watched_at`; the mock
// refuses them — stricter is the safe direction: what passes here passes there.

import { readFileSync } from 'node:fs';

import { parseDateTime } from './datetime.ts';

interface FieldError {
  readonly loc: readonly (string | number)[];
  readonly type: string;
  readonly msg: string;
  readonly ctx?: Readonly<Record<string, string | number | boolean | null>>;
}

/** `VALIDATION_ERRORS_REPORTED`: a 422 lists at most 20; `error_count` is the true total. */
const ERRORS_REPORTED = 20;

/** What a validation produced: at most `ERRORS_REPORTED` errors, and how many there were. */
export interface Errors {
  readonly errors: FieldError[];
  count: number;
}

export const noErrors = (): Errors => ({ errors: [], count: 0 });

function report(out: Errors, error: FieldError): void {
  out.count += 1;
  if (out.errors.length < ERRORS_REPORTED) out.errors.push(error);
}

type Loc = readonly (string | number)[];
type Check = (value: unknown, loc: Loc, out: Errors) => void;

type SchemaNode = Readonly<Record<string, unknown>>;

/** Keywords that only describe: ignored. */
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples']);

/** Keywords the compiler implements: anything else in a schema is refused at load. */
const ASSERTIONS = new Set([
  '$ref',
  'anyOf',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'items',
  'maxItems',
]);

const REF_PREFIX = '#/components/schemas/';

/** Compiles named component schemas, each once, refusing what it cannot honour. */
class SchemaCompiler {
  readonly #schemas: Readonly<Record<string, SchemaNode>>;
  readonly #compiled = new Map<string, Check>();

  constructor(schemas: Readonly<Record<string, SchemaNode>>) {
    this.#schemas = schemas;
  }

  named(name: string): Check {
    const done = this.#compiled.get(name);
    if (done !== undefined) return done;
    const schema = this.#schemas[name];
    if (schema === undefined) throw new Error(`the subset has no schema ${name}`);
    // Registered before it is compiled, so a schema that refers to itself compiles; the cell is
    // filled before anything can call it.
    const cell: { check: Check | null } = { check: null };
    const forward: Check = (value, loc, out) => {
      cell.check?.(value, loc, out);
    };
    this.#compiled.set(name, forward);
    cell.check = this.node(schema, name);
    return forward;
  }

  node(schema: SchemaNode, where: string): Check {
    const assertions = Object.keys(schema).filter((keyword) => !ANNOTATIONS.has(keyword));
    for (const keyword of assertions) {
      if (!ASSERTIONS.has(keyword)) {
        throw new Error(`mock-api cannot honour the schema keyword "${keyword}" at ${where}`);
      }
    }
    // `$ref` and `anyOf` stand alone in what Pydantic emits; a sibling would be ignored here.
    for (const alone of ['$ref', 'anyOf']) {
      if (assertions.includes(alone) && assertions.length > 1) {
        throw new Error(`mock-api cannot honour "${alone}" beside other keywords at ${where}`);
      }
    }
    const ref = schema.$ref;
    if (typeof ref === 'string') {
      if (!ref.startsWith(REF_PREFIX)) throw new Error(`unsupported $ref ${ref} at ${where}`);
      return this.named(ref.slice(REF_PREFIX.length));
    }
    const anyOf = schema.anyOf;
    if (Array.isArray(anyOf)) return this.#anyOf(anyOf as SchemaNode[], where);
    const type = schema.type;
    const title = typeof schema.title === 'string' ? schema.title : where;
    const checks: Check[] = [];
    switch (type) {
      case 'object':
        checks.push(this.#object(schema, title, where));
        break;
      case 'string':
        checks.push(this.#string(schema, where));
        break;
      case 'integer':
        checks.push(this.#integer(schema));
        break;
      case 'boolean':
        checks.push(typed('boolean', 'bool_type', 'Input should be a valid boolean'));
        break;
      case 'array':
        checks.push(this.#array(schema, where));
        break;
      case 'null':
        checks.push((value, loc, out) => {
          if (value !== null) {
            report(out, { loc, type: 'none_required', msg: 'Input should be None' });
          }
        });
        break;
      case undefined:
        break;
      default:
        throw new Error(`mock-api cannot honour type ${JSON.stringify(type)} at ${where}`);
    }
    const literal = literalCheck(schema);
    if (literal !== null) checks.push(literal);
    if (checks.length === 0) throw new Error(`a schema that checks nothing at ${where}`);
    return (value, loc, out) => {
      const before = out.count;
      for (const check of checks) {
        check(value, loc, out);
        if (out.count > before) return;
      }
    };
  }

  /** Every `anyOf` in a request is `X | null`: null passes, anything else answers to `X`. */
  #anyOf(branches: readonly SchemaNode[], where: string): Check {
    const allowsNull = branches.some((b) => b.type === 'null' && Object.keys(b).length === 1);
    const others = branches.filter((b) => !(b.type === 'null' && Object.keys(b).length === 1));
    const compiled = others.map((b, i) => this.node(b, `${where}.anyOf[${String(i)}]`));
    return (value, loc, out) => {
      if (value === null && allowsNull) return;
      if (compiled.length === 1) {
        compiled[0]?.(value, loc, out);
        return;
      }
      for (const check of compiled) {
        const scratch = noErrors();
        check(value, loc, scratch);
        if (scratch.count === 0) return;
      }
      report(out, { loc, type: 'union_error', msg: 'Input should match one of the allowed types' });
    };
  }

  #object(schema: SchemaNode, title: string, where: string): Check {
    const properties = (schema.properties ?? {}) as Readonly<Record<string, SchemaNode>>;
    const required = new Set((schema.required ?? []) as string[]);
    const extra = schema.additionalProperties;
    if (!(extra === undefined || extra === false)) {
      throw new Error(`mock-api honours additionalProperties false only, at ${where}`);
    }
    const fields = Object.entries(properties).map(
      ([name, child]) => [name, this.node(child, `${where}.${name}`)] as const,
    );
    return (value, loc, out) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        report(out, {
          loc,
          type: 'model_type',
          msg: `Input should be a valid dictionary or instance of ${title}`,
          ctx: { class_name: title },
        });
        return;
      }
      const object = value as Readonly<Record<string, unknown>>;
      for (const [name, check] of fields) {
        if (Object.hasOwn(object, name)) check(object[name], [...loc, name], out);
        else if (required.has(name)) {
          report(out, { loc: [...loc, name], type: 'missing', msg: 'Field required' });
        }
      }
      if (extra === false) {
        for (const name of Object.keys(object)) {
          if (!Object.hasOwn(properties, name)) {
            report(out, {
              loc: [...loc, name.slice(0, 100)],
              type: 'extra_forbidden',
              msg: 'Extra inputs are not permitted',
            });
          }
        }
      }
    };
  }

  #string(schema: SchemaNode, where: string): Check {
    const min = optionalInteger(schema.minLength, `${where}.minLength`);
    const max = optionalInteger(schema.maxLength, `${where}.maxLength`);
    const source = schema.pattern;
    if (!(source === undefined || typeof source === 'string')) {
      throw new Error(`a pattern that is not a string at ${where}`);
    }
    const pattern = source === undefined ? null : new RegExp(source, 'u');
    const format = schema.format;
    if (!(format === undefined || format === 'date-time')) {
      throw new Error(`mock-api cannot honour format ${JSON.stringify(format)} at ${where}`);
    }
    return (value, loc, out) => {
      if (typeof value !== 'string') {
        report(out, { loc, type: 'string_type', msg: 'Input should be a valid string' });
        return;
      }
      // Pydantic counts code points, as `maxLength` does; a JavaScript length counts UTF-16.
      const length = codePoints(value);
      if (min !== null && length < min) {
        report(out, {
          loc,
          type: 'string_too_short',
          msg: `String should have at least ${String(min)} character${min === 1 ? '' : 's'}`,
          ctx: { min_length: min },
        });
        return;
      }
      if (max !== null && length > max) {
        report(out, {
          loc,
          type: 'string_too_long',
          msg: `String should have at most ${String(max)} characters`,
          ctx: { max_length: max },
        });
        return;
      }
      if (pattern !== null && source !== undefined && !pattern.test(value)) {
        report(out, {
          loc,
          type: 'string_pattern_mismatch',
          msg: `String should match pattern '${source}'`,
          ctx: { pattern: source },
        });
        return;
      }
      if (format === 'date-time' && parseDateTime(value) === null) {
        report(out, {
          loc,
          type: 'datetime_from_date_parsing',
          msg: 'Input should be a valid datetime or date',
        });
      }
    };
  }

  #integer(schema: SchemaNode): Check {
    const min = optionalNumber(schema.minimum);
    const max = optionalNumber(schema.maximum);
    return (value, loc, out) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        report(out, { loc, type: 'int_type', msg: 'Input should be a valid integer' });
        return;
      }
      if (!Number.isInteger(value)) {
        report(out, {
          loc,
          type: 'int_from_float',
          msg: 'Input should be a valid integer, got a number with a fractional part',
        });
        return;
      }
      if (min !== null && value < min) {
        report(out, {
          loc,
          type: 'greater_than_equal',
          msg: `Input should be greater than or equal to ${String(min)}`,
          ctx: { ge: min },
        });
        return;
      }
      if (max !== null && value > max) {
        report(out, {
          loc,
          type: 'less_than_equal',
          msg: `Input should be less than or equal to ${String(max)}`,
          ctx: { le: max },
        });
      }
    };
  }

  #array(schema: SchemaNode, where: string): Check {
    const max = optionalInteger(schema.maxItems, `${where}.maxItems`);
    const items = schema.items;
    if (typeof items !== 'object' || items === null) {
      throw new Error(`an array without items at ${where}`);
    }
    const item = this.node(items as SchemaNode, `${where}.items`);
    return (value, loc, out) => {
      if (!Array.isArray(value)) {
        report(out, { loc, type: 'list_type', msg: 'Input should be a valid list' });
        return;
      }
      // Its length first: the items of a list too long are never examined.
      if (max !== null && value.length > max) {
        report(out, {
          loc,
          type: 'too_long',
          msg: `List should have at most ${String(max)} items after validation, not ${String(value.length)}`,
          ctx: { field_type: 'List', max_length: max, actual_length: value.length },
        });
        return;
      }
      (value as unknown[]).forEach((child, index) => {
        item(child, [...loc, index], out);
      });
    };
  }
}

function typed(kind: 'boolean', type: string, msg: string): Check {
  return (value, loc, out) => {
    if (typeof value !== kind) report(out, { loc, type, msg });
  };
}

/** `enum` and `const`, as Pydantic's `Literal` answers them (`literal_error`). */
function literalCheck(schema: SchemaNode): Check | null {
  const allowed: unknown[] | null = Array.isArray(schema.enum)
    ? (schema.enum as unknown[])
    : Object.hasOwn(schema, 'const')
      ? [schema.const]
      : null;
  if (allowed === null) return null;
  const expected = allowed.map((v) => `'${String(v)}'`).join(' or ');
  return (value, loc, out) => {
    if (!allowed.includes(value)) {
      report(out, {
        loc,
        type: 'literal_error',
        msg: `Input should be ${expected}`,
        ctx: { expected },
      });
    }
  };
}

function optionalInteger(value: unknown, where: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`a bound that is not a count at ${where}`);
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Code points (a lone surrogate counts one, as in Python); `text` is bounded by the body cap. */
const codePoints = (text: string): number => Array.from(text).length;

// ── the subset ───────────────────────────────────────────────────────────────────────────────

const SUBSET: unknown = JSON.parse(
  readFileSync(new URL('../openapi/openapi.subset.json', import.meta.url), 'utf8'),
);

function componentSchemas(document: unknown): Readonly<Record<string, SchemaNode>> {
  const schemas = (document as { components?: { schemas?: unknown } }).components?.schemas;
  if (typeof schemas !== 'object' || schemas === null) {
    throw new Error('the OpenAPI subset has no components.schemas');
  }
  return schemas as Readonly<Record<string, SchemaNode>>;
}

const COMPILER = new SchemaCompiler(componentSchemas(SUBSET));
const PLAY_EVIDENCE = COMPILER.named('PlayEvidence');
const TOKEN_FORM = COMPILER.named('Body_exchangeIntegrationToken');

/**
 * The 422 entries for a play body, `loc` under `body` as FastAPI writes it: the subset's
 * `PlayEvidence`, then — only when every field passed, as Pydantic's after-validators run — the
 * model's rules, the first that fails alone.
 */
export function playEvidenceErrors(value: unknown): Errors {
  const out = noErrors();
  PLAY_EVIDENCE(value, ['body'], out);
  if (out.count > 0) return out;
  const play = value as Readonly<Record<string, unknown>>;
  const unfit = storyRefusal(play);
  if (unfit !== null) {
    report(out, { loc: ['body'], type: 'value_error', msg: unfit });
    return out;
  }
  const watchedAt = play.watched_at;
  if (typeof watchedAt === 'string' && parseDateTime(watchedAt)?.offsetSeconds === null) {
    report(out, {
      loc: ['body'],
      type: 'value_error',
      msg: 'Value error, watched_at must carry a UTC offset',
    });
    return out;
  }
  if (!identifiesSomething(play)) {
    report(out, {
      loc: ['body'],
      type: 'value_error',
      msg:
        'Value error, a play needs at least one identifying field: a tmdb, imdb or tvdb id, a ' +
        'provider entry, a title, or a show that has one',
    });
    return out;
  }
  const unmeasured = startRefusal(play);
  if (unmeasured !== null) report(out, { loc: ['body'], type: 'value_error', msg: unmeasured });
  return out;
}

/**
 * `PlayEvidence._the_story_and_its_share_fit`: a story is never longer than the title, it comes
 * with the seconds of it played, and those are never more than the story — or than the title when
 * no story is sent. `null` when the numbers fit.
 */
function storyRefusal(play: Readonly<Record<string, unknown>>): string | null {
  const number = (key: string): number | null => {
    const value = play[key];
    return typeof value === 'number' ? value : null;
  };
  const story = number('story_seconds');
  const played = number('played_seconds');
  const duration = number('duration_seconds');
  if (story !== null && duration !== null && story > duration) {
    return 'Value error, story_seconds is never more than duration_seconds';
  }
  if (story !== null && played === null) {
    return (
      'Value error, story_seconds is sent with played_seconds: the lines are a share of the ' +
      'story, measured by how much of it was played'
    );
  }
  const bound = story ?? duration;
  if (played !== null && bound !== null && played > bound) {
    return (
      'Value error, played_seconds counts each second once: it is never more than ' +
      'story_seconds, or duration_seconds when no story is sent'
    );
  }
  return null;
}

/**
 * `PlayEvidence._a_start_can_be_measured`: a start is a film's, carries both numbers its line is
 * measured with, and never says it ended — a film played to its end is a viewing. `null` for a
 * viewing, and for a start that is all three.
 */
function startRefusal(play: Readonly<Record<string, unknown>>): string | null {
  if (play.report !== 'start') return null;
  if (play.kind !== 'movie') {
    return "Value error, a start is a film's: report 'start' takes kind 'movie'";
  }
  if (
    (play.duration_seconds ?? null) === null ||
    (play.furthest_position_seconds ?? null) === null
  ) {
    return (
      'Value error, a start carries duration_seconds and furthest_position_seconds: the ' +
      'threshold is a share of the one, measured against the other'
    );
  }
  if (play.ended === true) {
    return 'Value error, a start never says ended: a film played to its end is a viewing';
  }
  return null;
}

/** The 422 entries for the token endpoint's form (the last value of a repeated field wins). */
export function tokenFormErrors(form: Readonly<Record<string, string>>): Errors {
  const out = noErrors();
  TOKEN_FORM(form, ['body'], out);
  return out;
}

/** `EvidenceIds.identifies`, `ShowEvidence.identifies`, `PlayEvidence._identifies_something`. */
function identifiesSomething(play: Readonly<Record<string, unknown>>): boolean {
  const idsIdentify = (ids: unknown): boolean => {
    if (typeof ids !== 'object' || ids === null) return false;
    const { tmdb, imdb, tvdb, provider } = ids as Readonly<Record<string, unknown>>;
    return (
      (typeof tmdb === 'number' && tmdb !== 0) ||
      (typeof imdb === 'string' && imdb !== '') ||
      (typeof tvdb === 'number' && tvdb !== 0) ||
      (Array.isArray(provider) && provider.length > 0)
    );
  };
  const show = play.show;
  const showIdentifies =
    typeof show === 'object' &&
    show !== null &&
    (((show as Readonly<Record<string, unknown>>).title ?? null) !== null ||
      idsIdentify((show as Readonly<Record<string, unknown>>).ids));
  return idsIdentify(play.ids) || (play.title ?? null) !== null || showIdentifies;
}
