// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';
import {
  conditionAstSchema,
  actionsFieldSchema,
  type ActionsField,
  type ConditionAST,
  type ConditionalRule,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { conditionalRules } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as crudService from './conditional-rules.service.js';

// Phase 5b §5.8 — JSON + CSV import/export.
//
// JSON export bundles the rules array under a `rules` key + a
// version stamp so future format changes can detect+migrate.
//
// JSON import is atomic: validate every entry, then insert all
// of them inside a single transaction. A single bad rule rolls
// back the whole operation. The user gets a per-rule error
// report so they can fix the JSON and retry.
//
// CSV export is one row per rule; conditions and actions are
// JSON-stringified into cells. Re-import via CSV isn't
// supported in 5b — Excel + JSON cells round-trip unreliably.

export interface ExportRule {
  name: string;
  priority: number;
  conditions: ConditionAST;
  actions: ActionsField;
  continueAfterMatch: boolean;
  active: boolean;
  companyId: string | null;
}

export interface ExportBundle {
  version: 1;
  exportedAt: string;
  rules: ExportRule[];
}

export async function exportToJson(tenantId: string): Promise<ExportBundle> {
  const rules = await crudService.listForTenant(tenantId);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    rules: rules.map((r) => ({
      name: r.name,
      priority: r.priority,
      conditions: r.conditions,
      actions: r.actions,
      continueAfterMatch: r.continueAfterMatch,
      active: r.active,
      companyId: r.companyId,
    })),
  };
}

export async function exportToCsv(tenantId: string): Promise<string> {
  const rules = await crudService.listForTenant(tenantId);
  const stats = await crudService.statsForTenant(tenantId);
  const statsById = new Map(stats.map((s) => [s.ruleId, s]));

  const header = [
    'id',
    'name',
    'priority',
    'active',
    'continue_after_match',
    'company_id',
    'fires_total',
    'override_rate',
    'conditions_json',
    'actions_json',
  ];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rules) {
    const s = statsById.get(r.id);
    lines.push([
      r.id,
      r.name,
      String(r.priority),
      String(r.active),
      String(r.continueAfterMatch),
      r.companyId ?? '',
      String(s?.firesTotal ?? 0),
      s?.overrideRate === null || s?.overrideRate === undefined ? '' : String(s.overrideRate),
      JSON.stringify(r.conditions),
      JSON.stringify(r.actions),
    ].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}

// Inline schema rather than imported from shared — the
// recursive Zod schema in shared uses unexported local types,
// breaking declaration emit when this service's exports are
// re-bundled. Inlining trades a tiny duplication for a stable
// public-type surface.
const importRuleSchema = z.object({
  name: z.string().min(1).max(255),
  companyId: z.string().uuid().nullable().optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  conditions: conditionAstSchema,
  actions: actionsFieldSchema,
  continueAfterMatch: z.boolean().optional(),
  active: z.boolean().optional(),
});

const importBundleSchemaInternal = z.object({
  version: z.literal(1),
  exportedAt: z.string().optional(),
  rules: z.array(importRuleSchema).min(1).max(500),
});

export interface ImportReport {
  imported: number;
  errors: Array<{ index: number; message: string }>;
}

// Atomic import. Validates the entire bundle BEFORE writing,
// then inserts inside a transaction. If validation fails, throws
// an AppError with the per-rule errors attached as details.
export async function importJson(
  tenantId: string,
  rawBundle: unknown,
  createdBy?: string,
): Promise<ImportReport> {
  const parsed = importBundleSchemaInternal.safeParse(rawBundle);
  if (!parsed.success) {
    const errors = parsed.error.errors.map((err) => ({
      index: typeof err.path[1] === 'number' ? err.path[1] : -1,
      message: `${err.path.join('.')}: ${err.message}`,
    }));
    throw new AppError(400, 'Invalid import bundle', 'IMPORT_VALIDATION_FAILED', { errors });
  }

  const bundle = parsed.data;

  // 3-tier rules plan, Phase 2 — imported rules land as
  // tenant_user with the importer as the owner. Promote-to-firm/
  // global is a separate explicit action via the Phase-3
  // /promote endpoint. The CHECK constraint requires
  // owner_user_id be set; importing user has authority by virtue
  // of the route-level authenticate gate.
  if (!createdBy) {
    throw new AppError(400, 'Importing rules requires a logged-in user', 'IMPORT_NO_USER');
  }
  await db.transaction(async (tx) => {
    for (const rule of bundle.rules) {
      await tx.insert(conditionalRules).values({
        tenantId,
        companyId: rule.companyId ?? null,
        name: rule.name,
        priority: rule.priority ?? 100,
        // Drizzle's JSONB column accepts unknown — the Zod schema
        // already validated the structure end-to-end.
        conditions: rule.conditions as ConditionAST,
        actions: rule.actions as ActionsField,
        continueAfterMatch: rule.continueAfterMatch ?? false,
        active: rule.active ?? true,
        createdBy,
        scope: 'tenant_user',
        ownerUserId: createdBy,
        ownerFirmId: null,
      });
    }
  });

  return { imported: bundle.rules.length, errors: [] };
}

// CSV cells are wrapped in quotes when they contain commas /
// newlines / quotes. Quotes inside a cell are doubled per RFC
// 4180.
function csvEscape(cell: string): string {
  if (cell == null) return '';
  const needsQuoting = /[",\n\r]/.test(cell);
  if (!needsQuoting) return cell;
  return `"${cell.replace(/"/g, '""')}"`;
}

// Touch reference to silence unused-import lint when types
// re-export through callers.
export type _ConditionalRuleType = ConditionalRule;
