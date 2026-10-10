// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';
import type { Response } from 'express';

/**
 * Zod schemas for every /api/setup/* request body (CLAUDE.md rule 9). These
 * endpoints are unauthenticated by design — the first-run wizard has to be
 * reachable before any account exists — so untyped `req.body` reads were the
 * one place in the API where arbitrary JSON reached filesystem paths and
 * subprocess-ish work unchecked.
 */

const port = z.coerce.number().int().min(1).max(65535);
const nonEmpty = (max: number) => z.string().trim().min(1).max(max);
const secret32 = (label: string) => z.string().min(32, `${label} must be at least 32 characters`).max(4096);
const uuid = z.string().uuid();

export const dbConfigSchema = z.object({
  host: nonEmpty(253),
  port: port.default(5432),
  database: nonEmpty(128),
  username: nonEmpty(128),
  password: z.string().max(4096).default(''),
});

export const smtpConfigSchema = z.object({
  host: nonEmpty(253),
  port: port.default(587),
  username: z.string().max(512).optional(),
  password: z.string().max(4096).optional(),
  from: nonEmpty(320),
  fromName: z.string().max(200).optional(),
});

export const testSmtpSchema = smtpConfigSchema.extend({
  testEmail: z.string().trim().email().max(320).optional(),
});

export const checkPortSchema = z.object({ port });

export const initializeSchema = z
  .object({
    db: dbConfigSchema,
    redis: z
      .object({
        host: nonEmpty(253).default('redis'),
        port: port.default(6379),
        password: z.string().max(4096).optional(),
      })
      .default({ host: 'redis', port: 6379 }),
    smtp: smtpConfigSchema.optional(),
    jwtSecret: secret32('JWT secret'),
    backupKey: secret32('Backup encryption key'),
    encryptionKey: secret32('Installation encryption key'),
    // Clients no longer submit this; the server mints one when absent.
    plaidEncryptionKey: z.string().max(4096).optional(),
    appUrl: z.string().trim().url().max(2048).optional(),
    ports: z.object({ api: port.optional(), frontend: port.optional() }).optional(),
    admin: z.object({
      email: z.string().trim().email('A valid admin email is required').max(320),
      // Platform-wide password policy is 12 characters (see auth.service).
      password: z.string().min(12, 'Admin password must be at least 12 characters').max(1024),
      displayName: nonEmpty(255),
    }),
    company: z.object({
      name: z.string().trim().max(255).default(''),
      industry: z.string().trim().max(120).optional(),
      entityType: z.string().trim().max(60).optional(),
      businessType: z.string().trim().max(120).optional(),
    }),
    createDemoCompany: z.boolean().optional(),
    adoptExistingTenants: z.boolean().optional(),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.adoptExistingTenants && !cfg.company.name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['company', 'name'], message: 'Company name is required' });
    }
  });

export type InitializeInput = z.infer<typeof initializeSchema>;

const passphrase = z.string().min(1, 'Passphrase is required').max(4096);
const recoveryKey = z.string().trim().max(200).optional();

/** multipart text fields that ride alongside an uploaded backup file */
export const restoreUploadFieldsSchema = z.object({ passphrase, recoveryKey });

export const executeStagedSchema = z.object({ backupId: uuid, passphrase, recoveryKey });

export const stageIdParamSchema = z.object({ backupId: uuid });

export const localExecuteSchema = z.object({ id: nonEmpty(1024), passphrase, recoveryKey });

export const remoteCredsSchema = z.object({
  provider: z.enum(['b2', 's3']).default('b2'),
  bucket: nonEmpty(255),
  endpoint: nonEmpty(2048),
  keyId: nonEmpty(512),
  applicationKey: nonEmpty(4096),
  region: z.string().trim().max(64).optional(),
  prefix: z.string().max(1024).optional(),
});

export const remoteExecuteSchema = remoteCredsSchema.extend({
  keys: z.array(nonEmpty(2048)).min(1, 'keys (the object key[s] of the bundle part[s]) are required').max(10_000),
  passphrase,
  recoveryKey,
});

export const acknowledgeRecoveryKeySchema = z.object({
  installationId: uuid,
  claimToken: nonEmpty(256),
});

export const pendingRecoveryKeyQuerySchema = z.object({
  installationId: uuid,
  claimToken: nonEmpty(256),
});

export const recoverCredentialsSchema = z.object({
  recoveryKey: z.string().trim().min(1, 'recoveryKey is required').max(200),
});

export const runIdParamSchema = z.object({ runId: uuid });

/**
 * Parse `input` with `schema`; on failure send a 400 carrying the first issue
 * and return null so the handler can `return`.
 */
export function parseOr400<T extends z.ZodTypeAny>(schema: T, input: unknown, res: Response): z.infer<T> | null {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const where = first?.path.length ? `${first.path.join('.')}: ` : '';
  res.status(400).json({ error: { message: `${where}${first?.message ?? 'Invalid request'}`, code: 'VALIDATION_ERROR' } });
  return null;
}
