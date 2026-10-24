/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pnpm new:service <id> --host <domain>… [--name <name>]`: a service module's
// folder, ready for its samples — a `defineService` skeleton, an empty fixture, a test that fails
// naming each sample to capture, and a README to fill in — from the templates beside this file.
//
// The id is checked by `defineService` itself, so the rule has one spelling. A built-in site
// takes its name and hosts from the registry; any other service must name its hosts
// with `--host` — there is no placeholder, since a host is a permission. An
// id whose folder exists, or whose site has a module, is refused, and nothing is written. The
// module is not attached to the registry: that edit — and, for a new site, its new host
// permission — is the reviewer's.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { format, resolveConfig } from 'prettier';

import { loadServices } from '../docs/load-services.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVICES_DIR = join(ROOT, 'packages', 'services', 'src', 'services');
const TEMPLATES = fileURLToPath(new URL('./templates/', import.meta.url));

/** The files of a module folder, each from its template. */
const FILES = [
  { path: 'definition.ts', template: 'definition.ts.tmpl' },
  { path: 'definition.test.ts', template: 'definition.test.ts.tmpl' },
  { path: 'README.md', template: 'README.md.tmpl' },
  { path: 'fixtures/empty.snapshot.json', template: 'empty.snapshot.json.tmpl' },
] as const;

/** A request the scaffold refuses, naming why; nothing has been written. */
export class ScaffoldError extends Error {
  override readonly name = 'ScaffoldError';
}

export interface NewServiceOptions {
  /** The service's name, for a service that is not built in (default: the id in words). */
  readonly name?: string;
  /** Its hosts, for a service that is not built in (required there). */
  readonly hosts?: readonly string[];
  /** Where module folders live: the repository's own by default. */
  readonly servicesDir?: string;
}

/** ECMAScript's reserved words: an export may not be named one. */
const RESERVED = new Set(
  (
    'await break case catch class const continue debugger default delete do else enum export ' +
    'extends false finally for function if implements import in instanceof interface let new ' +
    'null package private protected public return static super switch this throw true try ' +
    'typeof var void while with yield arguments eval undefined'
  ).split(' '),
);

/** `prime_video` → `primeVideo`; a reserved word gains `Service`. */
function exportNameOf(id: string): string {
  const [first = '', ...rest] = id.split('_').filter((part) => part !== '');
  const name = first + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  return RESERVED.has(name) ? `${name}Service` : name;
}

/** `prime_video` → `Prime video`. */
const wordsOf = (id: string): string => {
  const words = id
    .split('_')
    .filter((part) => part !== '')
    .join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Markdown text: the characters that would start markup are escaped. */
const markdown = (text: string): string => text.replace(/[\\`*_[\]<>|#]/gu, '\\$&');

/** `{{key}}` → its value; a key the template names and the values lack is a bug, and throws. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Za-z]+)\}\}/gu, (_, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`template key {{${key}}} has no value`);
    return values[key] ?? '';
  });
}

/**
 * Creates `<servicesDir>/<id>/` with the four files and answers their paths. Throws
 * `ScaffoldError` — before writing anything — for an id `defineService` refuses, a folder that
 * exists, a built-in site that has a module, or hosts that are not one service's.
 */
export async function newService(
  id: string,
  options: NewServiceOptions = {},
): Promise<readonly string[]> {
  const { registry, sdk } = await loadServices();
  const probe = (name: string, hosts: readonly string[]): void => {
    sdk.defineService({
      id,
      name,
      version: '0.1.0',
      hosts,
      verified: null,
      playerRoutes: [/^\/watch\//u],
      collect: {},
      interpret: () => null,
    });
  };
  /** A refusal of one of `fields` (or of an element of one: `hosts[0]`) is the request's fault. */
  const refuseAs = (fields: readonly string[], run: () => void): void => {
    try {
      run();
    } catch (error) {
      if (
        error instanceof sdk.ServiceDefinitionError &&
        fields.some((field) => error.field === field || error.field.startsWith(`${field}[`))
      ) {
        throw new ScaffoldError(`${JSON.stringify(id)} refused: ${error.message}`);
      }
      throw error;
    }
  };

  // The id first, by defineService's own rule.
  refuseAs(['id'], () => {
    probe('Probe', ['probe.example']);
  });

  const servicesDir = options.servicesDir ?? SERVICES_DIR;
  const dir = join(servicesDir, id);
  if (existsSync(dir)) throw new ScaffoldError(`${id} exists: ${relative(ROOT, dir)}`);

  const site = registry.BUILT_IN_SITES.find((candidate) => candidate.id === id);
  let name: string;
  let hosts: readonly string[];
  let hostsComment: string;
  if (site !== undefined) {
    if (site.module !== null) throw new ScaffoldError(`${id} already has a module`);
    if (options.hosts !== undefined && options.hosts.length > 0) {
      throw new ScaffoldError(`${id} is a built-in site: its hosts come from the registry`);
    }
    if (options.name !== undefined) {
      throw new ScaffoldError(`${id} is a built-in site: its name comes from the registry`);
    }
    name = site.name;
    hosts = site.hosts;
    hostsComment = "The built-in site's hosts, as the registry lists them.";
  } else {
    if (options.hosts === undefined || options.hosts.length === 0) {
      throw new ScaffoldError(
        `${id} is not a built-in site: name its hosts with --host <domain> (repeat it for each)`,
      );
    }
    for (const host of options.hosts) {
      const claimant = registry.BUILT_IN_SITES.find((other) =>
        other.hosts.some((known) => sdk.coversHost(known, host) || sdk.coversHost(host, known)),
      );
      if (claimant !== undefined) throw new ScaffoldError(`${host} is ${claimant.id}'s host`);
    }
    hosts = options.hosts;
    hostsComment = 'Each host is a permission the extension asks for.';
    name = options.name ?? wordsOf(id);
  }
  refuseAs(['name', 'hosts'], () => {
    probe(name, hosts);
  });

  const exportName = exportNameOf(id);
  const values = {
    idTs: JSON.stringify(id),
    id,
    exportName,
    nameTs: JSON.stringify(name),
    nameComment: name,
    nameMd: markdown(name),
    hostsTs: JSON.stringify(hosts),
    hostsComment,
    hostsMd: hosts.map((host) => `\`${host}\``).join(', '),
    hostJson: JSON.stringify(hosts[0]),
  };

  // Everything is rendered before anything is written.
  const rendered: { readonly target: string; readonly text: string }[] = [];
  for (const file of FILES) {
    const target = join(dir, ...file.path.split('/'));
    const raw = fill(await readFile(join(TEMPLATES, file.template), 'utf8'), values);
    const config = (await resolveConfig(target)) ?? {};
    rendered.push({ target, text: await format(raw, { ...config, filepath: target }) });
  }

  try {
    await mkdir(dir); // not recursive: a folder that appeared meanwhile is refused, not reused
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new ScaffoldError(`${id} exists: ${relative(ROOT, dir)}`);
  }
  await mkdir(join(dir, 'fixtures'));
  for (const { target, text } of rendered) await writeFile(target, text, { flag: 'wx' });
  return rendered.map(({ target }) => target);
}

const USAGE =
  'usage: pnpm new:service <id> --host <domain> [--host <domain>]… [--name <name>]\n' +
  '       (a built-in site, e.g. prime_video, takes its hosts and name from the registry: no flags)';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { name: { type: 'string' }, host: { type: 'string', multiple: true } },
    allowPositionals: true,
    strict: true,
  });
  const [id] = positionals;
  if (id === undefined || positionals.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const files = await newService(id, {
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(values.host === undefined ? {} : { hosts: values.host }),
  });
  const { registry } = await loadServices();
  const builtIn = registry.BUILT_IN_SITES.some((site) => site.id === id);
  const steps = [
    [
      'Capture page samples on the service with a development build (CONTRIBUTING.md,',
      '"Capture a page sample"); save them under fixtures/ as definition.test.ts names them.',
    ],
    [
      'Declare what the module reads in definition.ts, explain it in README.md, and turn each',
      "failing test into its sample's expected reading.",
    ],
    builtIn
      ? [
          'Attach it: in packages/services/src/registry.ts, give the',
          `${id} site \`module: ${exportNameOf(id)}\`.`,
        ]
      : [
          'Attach it: add its site to BUILT_IN_SITES in packages/services/src/registry.ts. A new',
          'host is a new permission in an update, so a maintainer decides.',
        ],
    ['pnpm --filter @mt/services test, pnpm docs:services, pnpm lint.'],
  ];
  const lines = [
    `Created ${relative(ROOT, join(SERVICES_DIR, id))}/:`,
    ...files.map((file) => `  ${relative(ROOT, file)}`),
    '',
    'Next:',
    ...steps.flatMap((step, index) =>
      step.map((line, at) => (at === 0 ? `  ${String(index + 1)}. ${line}` : `     ${line}`)),
    ),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof ScaffoldError)) throw error;
    process.stderr.write(`new:service: ${error.message}\n`);
    process.exitCode = 1;
  }
}
