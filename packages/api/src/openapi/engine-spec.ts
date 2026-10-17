// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Loads the real engine app with the registration recorder installed and
 * builds its OpenAPI document (U-04). Shared by the export script and
 * the openapi tests.
 *
 * Importing app.ts does not connect to Postgres or Redis: the pg Pool and
 * every Redis/BullMQ client in the import graph are created lazily, and
 * the rate-limit store is in-memory unless RATE_LIMIT_REDIS=1. The caller
 * is responsible for setting the env vars config/env.ts requires before
 * calling this (the export script forces unreachable dummy values).
 */

import type { Express } from 'express';
import { readFileSync } from 'node:fs';
import { installRecorder, type RouteCollection } from './recorder.js';
import { buildOpenApiDocument, type SecurityScheme } from './generate.js';
import { checkSkipped, SKIP_TABLE } from './skip-table.js';

export interface EngineSpec {
  app: Express;
  collection: RouteCollection;
  doc: Record<string, unknown>;
}

const BEARER: SecurityScheme = {
  name: 'BearerAuth',
  scheme: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
};
const API_KEY: SecurityScheme = {
  name: 'ApiKeyAuth',
  scheme: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
};

let cached: Promise<EngineSpec> | null = null;

/** Imports the app once per process; later calls reuse the result. */
export function loadEngineSpec(): Promise<EngineSpec> {
  cached ??= load();
  return cached;
}

async function load(): Promise<EngineSpec> {
  const recorder = installRecorder();
  let app: Express;
  let collection: RouteCollection;
  try {
    ({ app } = await import('../app.js'));
    collection = recorder.collect(app);
  } finally {
    recorder.uninstall();
  }
  if (collection.routes.length === 0) {
    throw new Error(
      'openapi: no routes recorded — app.ts was imported before the recorder was installed',
    );
  }

  const { authenticate } = await import('../middleware/auth.js');
  const { apiKeyAuth } = await import('../middleware/api-key-auth.js');
  const { portalAuthenticate, PORTAL_SESSION_COOKIE } = await import('../middleware/portal-auth.js');
  const { peerAuth } = await import('../middleware/peer-auth.js');

  const security = new Map<unknown, SecurityScheme[]>([
    // authenticate() accepts a JWT bearer token or an X-API-Key header.
    [authenticate, [BEARER, API_KEY]],
    [apiKeyAuth, [API_KEY]],
    [
      portalAuthenticate,
      [{ name: 'PortalSession', scheme: { type: 'apiKey', in: 'cookie', name: PORTAL_SESSION_COOKIE } }],
    ],
    [peerAuth, [{ name: 'PeerToken', scheme: { type: 'http', scheme: 'bearer' } }]],
  ]);

  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  checkSkipped(collection.skipped);

  const doc = buildOpenApiDocument(collection.routes, {
    title: 'Vibe MyBooks engine API',
    version: pkg.version,
    description:
      'Generated from the Express route registrations by `npm run openapi:export`. ' +
      'Do not edit by hand. Request bodies come from validate() Zod schemas; ' +
      'responses are not yet documented unless a route uses describe().',
    security,
    skipped: collection.skipped.map((s) => ({ key: s.key, reason: SKIP_TABLE[s.key] ?? s.reason })),
  });
  return { app, collection, doc };
}
