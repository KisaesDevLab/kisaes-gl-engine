// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
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
