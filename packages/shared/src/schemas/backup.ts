// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

export const createBackupSchema = z.object({
  passphrase: z.string().min(12, 'Passphrase must be at least 12 characters'),
  include_attachments: z.boolean().optional().default(true),
});

export const restoreBackupSchema = z.object({
  passphrase: z.string().optional(),
});

export const tenantExportSchema = z.object({
  passphrase: z.string().min(12, 'Passphrase must be at least 12 characters'),
  date_range: z.object({
    from: z.string(),
    to: z.string(),
  }).optional(),
  include_attachments: z.boolean().optional().default(true),
  include_audit: z.boolean().optional().default(true),
  include_bank_rules: z.boolean().optional().default(true),
});

export const tenantImportValidateSchema = z.object({
  passphrase: z.string().min(1, 'Passphrase is required'),
});

export const tenantImportSchema = z.object({
  validation_token: z.string().uuid(),
  mode: z.enum(['new', 'merge']),
  company_name: z.string().min(1).max(255).optional(),
  assign_users: z.array(z.string().uuid()).optional(),
  target_company_id: z.string().uuid().optional(),
});

export const remoteBackupConfigSchema = z.object({
  enabled: z.boolean(),
  destination: z.enum(['sftp', 'webdav', 'email']),
  schedule: z.enum(['daily', 'weekly', 'monthly']),
  retention_count: z.number().int().min(1).max(100).default(10),
  passphrase: z.string().min(12).optional(),
  sftp: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().min(1),
    auth_method: z.enum(['password', 'key']).default('password'),
    password: z.string().optional(),
    remote_path: z.string().min(1).default('/backups/'),
  }).optional(),
  webdav: z.object({
    url: z.string().url(),
    username: z.string().min(1),
    password: z.string().optional(),
  }).optional(),
  email: z.object({
    recipient: z.string().email(),
    max_size_mb: z.number().int().min(1).max(50).default(25),
  }).optional(),
});

export const passphraseStrengthSchema = z.object({
  passphrase: z.string(),
});
