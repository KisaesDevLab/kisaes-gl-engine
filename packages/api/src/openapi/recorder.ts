// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Express registration recorder (U-04).
 *
 * Express 4 keeps only compiled regexps for mounted routers, so the mount
 * paths needed for an OpenAPI document cannot be read back from
 * `app._router.stack` after the fact. The recorder patches the public
 * prototype methods every registration goes through:
 *
 *   - `Router#use(path?, ...fns)` — `app.use()` forwards here once per fn
 *   - `Router#route(path)`        — `app.METHOD()`, `router.METHOD()` and
 *                                   `router.route()` all create their Route
 *                                   through it
 *   - `Route#METHOD(...fns)` / `Route#all(...fns)` — the route's handlers
 *
 * Handlers are captured from the call arguments rather than read back from
 * layers, because express-async-errors replaces every `layer.handle` with
 * a wrapper, which would hide the original functions (and the metadata
 * `validate()` / `describe()` attach to them).
 *
 * Each call is appended, in order, to a per-router entry list. After the
 * app module has been imported, `collect()` walks the tree from the app's
 * root router and joins mount paths. Routers mounted twice are expanded
 * twice; two routers on one base are both expanded.
 *
 * The recorder is installed ONLY by the OpenAPI export script and the
 * openapi tests. Nothing in the server imports this file, so it has no
 * runtime cost on the appliance.
 */

import express from 'express';
import { METHODS } from 'node:http';

// Any Express handler or middleware; compared by identity only.
type Handler = (...args: never[]) => unknown;

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

type RawPath = string | RegExp | Array<string | RegExp>;

interface RouteLayer {
  method?: string;
  handle: Handler;
}

interface ExpressRoute {
  path: RawPath;
  stack: RouteLayer[];
}

/** Handlers registered on a Route; `method` undefined means `.all()`. */
interface RouteRegistration {
  method?: string;
  fns: Handler[];
}

type Entry =
  | { kind: 'use'; path: RawPath; fns: Handler[] }
  | { kind: 'route'; path: RawPath; route: ExpressRoute };

/** One concrete operation reachable through the app. */
export interface RecordedRoute {
  method: HttpMethod;
  /** Express-style full path, e.g. `/api/v1/accounts/:id`. */
  expressPath: string;
  /** OpenAPI-style full path, e.g. `/api/v1/accounts/{id}`. */
  path: string;
  /** Path parameter names in order. */
  params: string[];
  /**
   * Every function that runs for this operation, outermost first:
   * app-level and router-level middleware that applies to the path,
   * then the route's own handlers for this method.
   */
  chain: Handler[];
}

/** A registration that cannot be expressed as an OpenAPI path. */
export interface SkippedRegistration {
  /** Stable key used by the skip table, e.g. `GET /api/v1/files/*`. */
  key: string;
  reason: string;
}

export interface RouteCollection {
  routes: RecordedRoute[];
  skipped: SkippedRegistration[];
  /** Operations hidden by an earlier registration of the same method + path. */
  shadowed: RecordedRoute[];
}

export interface Recorder {
  /** Restores the original prototype methods. Idempotent. */
  uninstall(): void;
  /** Walks the recorded registrations from `app` and returns every operation. */
  collect(app: unknown): RouteCollection;
}

type RouterLike = Handler & {
  stack?: unknown[];
  use: (...args: unknown[]) => unknown;
  route: (path: RawPath) => ExpressRoute;
};

type Patchable = Record<string, (this: unknown, ...args: unknown[]) => unknown>;

// In Express 4 `express.Router` is the prototype object every router
// function is given via setPrototypeOf; `express.Route` is the Route class.
const routerProto = express.Router as unknown as Patchable;
const routeProto = (express as unknown as { Route: { prototype: Patchable } }).Route.prototype;

function isRouter(fn: unknown): fn is RouterLike {
  return typeof fn === 'function' && Object.getPrototypeOf(fn) === routerProto;
}

function flatten(args: unknown[]): Handler[] {
  const out: Handler[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === 'function') out.push(v as Handler);
  };
  args.forEach(visit);
  return out;
}

/** Mirrors Express 4 `Router#use` argument parsing. */
function splitUseArgs(args: unknown[]): { path: RawPath; fns: Handler[] } {
  let offset = 0;
  let path: RawPath = '/';
  const first = args[0];
  if (typeof first !== 'function') {
    let arg: unknown = first;
    while (Array.isArray(arg) && arg.length !== 0) arg = arg[0];
    if (typeof arg !== 'function') {
      offset = 1;
      path = first as RawPath;
    }
  }
  return { path, fns: flatten(args.slice(offset)) };
}

let active: Recorder | null = null;

export function installRecorder(): Recorder {
  if (active) throw new Error('openapi recorder is already installed');

  const entries = new WeakMap<object, Entry[]>();
  const routeRegs = new WeakMap<object, RouteRegistration[]>();
  const push = <K extends object, V>(map: WeakMap<K, V[]>, key: K, value: V) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  const originals = new Map<string, { target: Patchable; fn: Patchable[string] }>();
  const patch = (target: Patchable, name: string, make: (orig: Patchable[string]) => Patchable[string]) => {
    const orig = target[name];
    if (typeof orig !== 'function') return;
    originals.set(`${target === routerProto ? 'router' : 'route'}.${name}`, { target, fn: orig });
    target[name] = make(orig);
  };

  patch(routerProto, 'use', (orig) =>
    function recordedUse(this: unknown, ...args: unknown[]) {
      const { path, fns } = splitUseArgs(args);
      push(entries, this as object, { kind: 'use', path, fns });
      return orig.apply(this, args);
    },
  );
  patch(routerProto, 'route', (orig) =>
    function recordedRoute(this: unknown, ...args: unknown[]) {
      const route = orig.apply(this, args) as ExpressRoute;
      push(entries, this as object, { kind: 'route', path: args[0] as RawPath, route });
      return route;
    },
  );
  for (const name of [...METHODS.map((m) => m.toLowerCase()), 'all']) {
    patch(routeProto, name, (orig) =>
      function recordedRouteMethod(this: unknown, ...args: unknown[]) {
        push(routeRegs, this as object, {
          method: name === 'all' ? undefined : name,
          fns: flatten(args),
        });
        return orig.apply(this, args);
      },
    );
  }

  const recorder: Recorder = {
    uninstall() {
      if (active !== recorder) return;
      for (const [key, { target, fn }] of originals) target[key.slice(key.indexOf('.') + 1)] = fn;
      active = null;
    },
    collect(app: unknown) {
      const root = (app as { _router?: unknown })._router;
      if (!isRouter(root)) return { routes: [], skipped: [], shadowed: [] };
      return expand(
        root,
        (r) => entries.get(r) ?? [],
        (route) =>
          routeRegs.get(route) ??
          // Registered before the recorder was installed: fall back to the
          // (possibly wrapped) layer handles.
          route.stack.map((l) => ({ method: l.method, fns: [l.handle] })),
      );
    },
  };
  active = recorder;
  return recorder;
}

// ── Expansion ────────────────────────────────────────────────────────

function describePath(p: RawPath): string {
  if (Array.isArray(p)) return `[${p.map(describePath).join(',')}]`;
  return p instanceof RegExp ? p.toString() : p;
}

/** Joins a mount prefix and a sub-path the way Express resolves them. */
export function joinPaths(prefix: string, sub: string): string {
  const a = prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  const b = sub === '/' || sub === '' ? '' : sub.startsWith('/') ? sub : `/${sub}`;
  const joined = `${a}${b}`.replace(/\/+$/, '');
  return joined === '' ? '/' : joined;
}

const PARAM_RE = /^:([A-Za-z0-9_]+)$/;

/**
 * Converts a plain Express path to OpenAPI form. Returns null when the
 * path uses features OpenAPI paths cannot express (wildcards, optional
 * params, inline param regexps).
 */
export function toOpenApiPath(expressPath: string): { path: string; params: string[] } | null {
  if (/[*?()+\\[\]]/.test(expressPath)) return null;
  const params: string[] = [];
  const segments = expressPath.split('/').map((seg) => {
    if (!seg.includes(':')) return seg;
    const m = PARAM_RE.exec(seg);
    if (!m) return null; // `:a-:b`, `file.:ext` and friends
    params.push(m[1]!);
    return `{${m[1]}}`;
  });
  if (segments.some((s) => s === null)) return null;
  return { path: segments.join('/'), params };
}

/** True when middleware mounted at `mountPath` runs for requests to `fullPath`. */
function pathApplies(mountPath: string, fullPath: string): boolean {
  if (mountPath === '/') return true;
  const m = mountPath.split('/').filter(Boolean);
  const f = fullPath.split('/').filter(Boolean);
  if (m.length > f.length) return false;
  return m.every((seg, i) => seg.startsWith(':') || f[i]!.startsWith(':') || seg === f[i]);
}

/** Array paths of plain strings behave like one registration per string. */
function stringPaths(p: RawPath): string[] | null {
  if (typeof p === 'string') return [p];
  if (Array.isArray(p) && p.length > 0 && p.every((x) => typeof x === 'string')) return p as string[];
  return null;
}

function expand(
  root: RouterLike,
  entriesOf: (r: object) => Entry[],
  registrationsOf: (route: ExpressRoute) => RouteRegistration[],
): RouteCollection {
  const routes: RecordedRoute[] = [];
  const skipped: SkippedRegistration[] = [];
  const shadowed: RecordedRoute[] = [];
  const seen = new Set<string>();

  const walk = (router: RouterLike, prefix: string, inherited: Handler[]): void => {
    // Middleware registered with use() on this router so far, with the
    // full path it applies to. Order matters: only middleware registered
    // before a route runs ahead of it.
    const local: Array<{ path: string; fn: Handler }> = [];
    const applicableTo = (full: string) =>
      local.filter((l) => pathApplies(l.path, full)).map((l) => l.fn);

    for (const entry of entriesOf(router)) {
      const subPaths = stringPaths(entry.path);
      if (!subPaths) {
        const kind = entry.kind === 'use' ? 'USE' : 'ROUTE';
        skipped.push({
          key: `${kind} ${joinPaths(prefix, '/')} ${describePath(entry.path)}`,
          reason: 'RegExp path',
        });
        continue;
      }

      for (const sub of subPaths) {
        const full = joinPaths(prefix, sub);

        if (entry.kind === 'use') {
          const before: Handler[] = [];
          for (const fn of entry.fns) {
            if (isRouter(fn)) {
              walk(fn, full, [...inherited, ...applicableTo(full), ...before]);
            } else {
              before.push(fn);
              local.push({ path: full, fn });
            }
          }
          continue;
        }

        // kind === 'route'
        const regs = registrationsOf(entry.route);
        const allHandlers = regs.filter((r) => r.method === undefined);
        const methods = new Set(
          regs.map((r) => r.method).filter((m): m is string => typeof m === 'string'),
        );
        if (allHandlers.length > 0 && methods.size === 0) {
          skipped.push({ key: `ALL ${full}`, reason: 'route.all() has no single OpenAPI method' });
          continue;
        }
        const converted = toOpenApiPath(full);
        const prefixChain = [...inherited, ...applicableTo(full)];
        for (const method of [...methods].sort()) {
          const upper = method.toUpperCase();
          if (!(HTTP_METHODS as readonly string[]).includes(method)) {
            skipped.push({ key: `${upper} ${full}`, reason: `unsupported method ${upper}` });
            continue;
          }
          if (!converted) {
            skipped.push({ key: `${upper} ${full}`, reason: 'wildcard, optional or regexp parameter' });
            continue;
          }
          const handlers = regs
            .filter((r) => r.method === method || r.method === undefined)
            .flatMap((r) => r.fns);
          const rec: RecordedRoute = {
            method: method as HttpMethod,
            expressPath: full,
            path: converted.path,
            params: converted.params,
            chain: [...prefixChain, ...handlers],
          };
          const id = `${method} ${converted.path}`;
          if (seen.has(id)) shadowed.push(rec);
          else {
            seen.add(id);
            routes.push(rec);
          }
        }
      }
    }
  };

  walk(root, '/', []);
  return { routes, skipped, shadowed };
}

// ── Independent cross-check ──────────────────────────────────────────

interface StackLayer {
  route?: { stack: Array<{ method?: string }> };
  handle: unknown;
  regexp?: RegExp;
}

/**
 * Counts route-level (layer × method) registrations by walking Express's
 * own `_router.stack` tree, without using anything the recorder captured.
 * A router mounted twice is counted twice; a route whose path is an array
 * of N strings is counted N times (Express compiles it to one layer, the
 * recorder expands it). Used by tests to prove the recorder missed nothing.
 */
export function countStackRoutes(app: unknown): number {
  const root = (app as { _router?: { stack: StackLayer[] } })._router;
  if (!root) return 0;
  // express-async-errors wraps every layer.handle but copies enumerable
  // props, so a mounted router (wrapped or not) still exposes its `stack`.
  const subStack = (h: unknown): StackLayer[] | null => {
    if (typeof h !== 'function') return null;
    const s = (h as { stack?: unknown }).stack;
    return Array.isArray(s) ? (s as StackLayer[]) : null;
  };
  const walk = (stack: StackLayer[]): number => {
    let n = 0;
    for (const layer of stack) {
      if (layer.route) {
        n += new Set(layer.route.stack.map((l) => l.method ?? '_all')).size;
      } else {
        const inner = subStack(layer.handle);
        if (inner) n += walk(inner);
      }
    }
    return n;
  };
  return walk(root.stack);
}
