// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';
import { isDesktop } from '../desktop/profile.js';

/**
 * Desktop: a pool connection is closed after this many uses (P33 review M7).
 * The record-stamp triggers keep a transaction-local setting per record they
 * touch (0286, `mybooks.s_*`). Its value ends with the transaction, but
 * PostgreSQL keeps each setting's name for the life of the connection (about
 * 460 bytes each; RESET ALL and DISCARD ALL free nothing, measured on 16), so
 * a long-lived connection would grow without bound. Recycling bounds it; a
 * new local connection costs a few milliseconds per thousand uses.
 */
export const DESKTOP_POOL_MAX_USES = 1000;

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  // Desktop only (U-291, stale-all-v1): every connection starts with
  // mybooks.desktop = on, which turns on the record-stamp triggers (and,
  // from U-294, the change feed). The server appliance never sets it.
  ...(isDesktop() ? { options: '-c mybooks.desktop=on', maxUses: DESKTOP_POOL_MAX_USES } : {}),
});

export const db = drizzle(pool, { schema });
export { pool };

// Drizzle's transaction handle (the parameter passed to db.transaction's
// callback) exposes the same query interface as `db`, but TypeScript treats
// the two as distinct types. Helpers that need to work both with the global
// pool and inside an active transaction take a `DbOrTx` parameter.
//
// The Parameters<Parameters<...>[0]>[0] trick extracts the type from the
// existing API surface so we don't have to import internal Drizzle types
// (which differ across drivers and Drizzle versions).
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;
