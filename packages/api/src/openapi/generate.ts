// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Builds an OpenAPI 3.1.0 document from recorded routes (U-04).
 *
 * Input is the recorder's operation list. Request bodies come from the
 * Zod schemas `validate()` attaches; summaries, tags, query/path
 * parameter schemas and response schemas come from optional
 * `describe()` middleware. Responses without a documented schema are
 * emitted as a generic `default` response — nothing is invented.
 *
 * The output is deterministic: keys are sorted at every level, and Zod
 * defaults that are computed at call time (timestamps, random ids) are
 * dropped, so two exports of the same code are byte-identical.
 */

import { zodToJsonSchema, ignoreOverride } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { getOpenApiMeta, type OpenApiMeta } from '../middleware/describe.js';
import type { RecordedRoute, SkippedRegistration } from './recorder.js';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

export interface SecurityScheme {
  /** Name used under components.securitySchemes. */
  name: string;
  scheme: JsonObject;
}

export interface BuildOptions {
  title: string;
  version: string;
  description?: string;
  /**
   * Middleware function → the security schemes it accepts (any one of
   * them satisfies the operation). The first match in an operation's
   * chain wins.
   */
  security: Map<unknown, SecurityScheme[]>;
  skipped?: SkippedRegistration[];
}

// ── Zod → JSON Schema ────────────────────────────────────────────────

const VOLATILE_DEFAULT = /^\d{4}-\d{2}-\d{2}/;

type ZodDefaultDef = { typeName?: string; defaultValue?: () => unknown; innerType?: ZodTypeAny };

/**
 * Converts a Zod schema to an OpenAPI 3.1 (JSON Schema 2020-12 compatible)
 * schema object. Money fields keep whatever the Zod type says — a decimal
 * string stays `type: string` with its pattern; a `z.number()` stays
 * `number` (callers must treat the latter as a finding, not a contract).
 */
export function zodToOpenApiSchema(schema: ZodTypeAny): JsonObject {
  // zod-to-json-schema warns on every recursive z.lazy() reference it
  // replaces with `{}` (any). That is the intended result with
  // $refStrategy 'none', so keep the export output quiet.
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('Recursive reference detected')) return;
    warn(...args);
  };
  try {
    return convert(schema);
  } finally {
    console.warn = warn;
  }
}

function convert(schema: ZodTypeAny): JsonObject {
  const out = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
    effectStrategy: 'input',
    pipeStrategy: 'input',
    dateStrategy: 'format:date-time',
    // Only `.strict()` objects reject unknown keys; Zod's default
    // (strip) accepts and drops them, so it must not say
    // additionalProperties: false.
    removeAdditionalStrategy: 'strict',
    override: (def) => {
      const d = def as unknown as ZodDefaultDef;
      if (d.typeName !== 'ZodDefault' || !d.defaultValue || !d.innerType) return ignoreOverride;
      let volatile = true;
      try {
        const a = d.defaultValue();
        const b = d.defaultValue();
        volatile =
          a instanceof Date ||
          (typeof a === 'string' && VOLATILE_DEFAULT.test(a)) ||
          JSON.stringify(a) !== JSON.stringify(b);
      } catch {
        // A default that throws outside a request cannot be documented.
      }
      if (!volatile) return ignoreOverride;
      // Same schema, minus the call-time default.
      return convert(d.innerType) as never;
    },
  }) as JsonObject;
  delete out['$schema'];
  delete out['definitions'];
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────

function mergedMeta(chain: RecordedRoute['chain']): OpenApiMeta {
  const meta: OpenApiMeta = {};
  for (const fn of chain) {
    const m = getOpenApiMeta(fn);
    if (m) Object.assign(meta, m);
  }
  return meta;
}

/** Turns an object schema into OpenAPI parameter objects. */
function objectParams(schema: ZodTypeAny, location: 'query' | 'path'): JsonObject[] {
  const json = zodToOpenApiSchema(schema);
  const props = (json['properties'] ?? {}) as JsonObject;
  const required = new Set(((json['required'] ?? []) as string[]));
  return Object.keys(props).map((name) => ({
    name,
    in: location,
    required: location === 'path' ? true : required.has(name),
    schema: props[name] as Json,
  }));
}

/** First path segment after `/api[/vN]`, used as the default tag. */
export function defaultTag(path: string): string {
  const segs = path.split('/').filter(Boolean);
  if (segs[0] !== 'api') return segs[0]?.replace(/[{}]/g, '') || 'root';
  const rest = /^v\d+$/.test(segs[1] ?? '') ? segs.slice(2) : segs.slice(1);
  const head = rest[0]?.replace(/[{}]/g, '') ?? 'root';
  return segs[1] === 'v2' ? `v2-${head}` : head;
}

export function operationIdFor(method: string, path: string): string {
  const body = path
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith('{') ? `by_${s.slice(1, -1)}` : s))
    .join('_')
    .replace(/[^A-Za-z0-9_]+/g, '_');
  return `${method}_${body || 'root'}`;
}

/** JSON.stringify with recursively sorted object keys, 2-space indent, trailing newline. */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .filter((k) => o[k] !== undefined)
          .map((k) => [k, sort(o[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

// ── Document ─────────────────────────────────────────────────────────

export function buildOpenApiDocument(routes: RecordedRoute[], opts: BuildOptions): JsonObject {
  const paths: Record<string, Record<string, JsonObject>> = {};
  const usedSchemes = new Map<string, JsonObject>();
  const usedIds = new Set<string>();

  const ordered = [...routes].sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path < b.path ? -1 : 1,
  );

  for (const route of ordered) {
    const meta = mergedMeta(route.chain);
    const op: JsonObject = {};

    let id = operationIdFor(route.method, route.path);
    for (let n = 2; usedIds.has(id); n++) id = `${operationIdFor(route.method, route.path)}_${n}`;
    usedIds.add(id);
    op['operationId'] = id;
    op['tags'] = meta.tags ?? [defaultTag(route.path)];
    if (meta.summary) op['summary'] = meta.summary;
    if (meta.description) op['description'] = meta.description;
    if (meta.deprecated) op['deprecated'] = true;

    // Path parameters: every template name, typed by describe({params}) when given.
    const typedPath = meta.params ? objectParams(meta.params, 'path') : [];
    const params: JsonObject[] = route.params.map(
      (name) =>
        typedPath.find((p) => p['name'] === name) ?? {
          name,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
    );
    if (meta.query) params.push(...objectParams(meta.query, 'query'));
    if (params.length > 0) op['parameters'] = params;

    if (meta.body && route.method !== 'get' && route.method !== 'head') {
      op['requestBody'] = {
        required: true,
        content: { 'application/json': { schema: zodToOpenApiSchema(meta.body) } },
      };
    }

    const responses: JsonObject = {
      default: { description: 'Response not yet documented in this specification.' },
    };
    if (meta.response) {
      responses['200'] = {
        description: 'Success',
        content: { 'application/json': { schema: zodToOpenApiSchema(meta.response) } },
      };
    }
    op['responses'] = responses;

    const auth = route.chain.map((fn) => opts.security.get(fn)).find((s) => s !== undefined);
    if (auth) {
      op['security'] = auth.map((s) => ({ [s.name]: [] }));
      for (const s of auth) usedSchemes.set(s.name, s.scheme);
    }

    (paths[route.path] ??= {})[route.method] = op;
  }

  const doc: JsonObject = {
    openapi: '3.1.0',
    info: {
      title: opts.title,
      version: opts.version,
      ...(opts.description ? { description: opts.description } : {}),
    },
    paths: paths as unknown as JsonObject,
  };
  if (usedSchemes.size > 0) {
    doc['components'] = { securitySchemes: Object.fromEntries(usedSchemes) };
  }
  if (opts.skipped && opts.skipped.length > 0) {
    doc['x-skipped-routes'] = [...opts.skipped]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((s) => ({ route: s.key, reason: s.reason }));
  }
  return doc;
}
