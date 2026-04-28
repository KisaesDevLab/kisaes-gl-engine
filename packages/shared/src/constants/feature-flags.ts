// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Eight Practice-Management feature flags introduced by
// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 1. Each flag gates one
// Practice sidebar child surface. Flags default OFF for tenants that
// existed before Phase 1 (see migration 0065) and ON for tenants
// created afterwards (see auth.service.register +
// createClientTenant).
//
// Keep this list in sync with:
//   - migration 0065_practice_foundation.sql (seed rows)
//   - feature-flags.service.ts (seedDefaultsForNewTenant)
//   - Sidebar > PracticeGroup nav items
//   - App.tsx /practice/* route guards
//
// The key format is SCREAMING_SNAKE_CASE with a `_V` suffix for
// versioning so later phases can flip the gate without leaving stale
// truthy rows in the DB (e.g. graduate `CLOSE_REVIEW_V1` to
// `CLOSE_REVIEW_V2` once a rewrite lands).
export const PRACTICE_FEATURE_FLAGS = [
  'CLOSE_REVIEW_V1',
  'AI_BUCKET_WORKFLOW_V1',
  'CONDITIONAL_RULES_V1',
  'CLIENT_PORTAL_V1',
  'REMINDERS_V1',
  'TAX_1099_V1',
  'REPORT_BUILDER_V1',
  'RECEIPT_PWA_V1',
  // Phase: AI expansion in Close Review. Each flag gates one
  // additional AI-driven capability so admins can stage the rollout.
  'AI_VENDOR_ENRICHMENT_V1',
  'AI_VENDOR_ENRICHMENT_V2',
  'AI_JUDGMENT_CHECKS_V1',
  // 3-tier rules plan, Phase 2. Default OFF on existing tenants
  // and OFF on newly-created tenants. When OFF, the conditional-
  // rules pipeline + UI ignore `scope` entirely (every rule reads
  // as today's tenant_user behavior). Flipping ON exposes the
  // tenant_firm + global_firm tiers via the firm-admin surface
  // and changes the evaluator order. Graduate to V2 / drop the
  // gate once canary completes.
  'RULES_TIERED_V1',
  // Calendar-cadence document-request reminders. When ON, the
  // recurring-doc-request scheduler issues monthly document_requests
  // rows for the tenant + the reminder dispatch loop escalates open
  // requests via the existing template engine. Default OFF so a CPA
  // turns it on when they're ready to author standing rules.
  'RECURRING_DOC_REQUESTS_V1',
  // SMS channel for doc-request reminders. Sub-flag of
  // RECURRING_DOC_REQUESTS_V1 — even when ON, dispatch only attempts
  // SMS when the tenant has portal_settings_per_practice
  // .sms_outbound_enabled=true AND a system-wide SMS provider is
  // configured. Default OFF.
  'DOC_REQUEST_SMS_V1',
  // Cron-style cadences for recurring_document_requests. Adds the
  // `cron` cadence_kind branch alongside the existing
  // monthly/quarterly/annually frequencies. Default OFF.
  'RECURRING_CRON_V1',
  // Auto-route portal-uploaded statements into bank_feed_items
  // instead of the receipts inbox when the document_request's type
  // is bank_statement or cc_statement. Default OFF.
  'STATEMENT_AUTO_IMPORT_V1',
] as const;

export type PracticeFeatureFlagKey = typeof PRACTICE_FEATURE_FLAGS[number];

export function isPracticeFeatureFlagKey(key: string): key is PracticeFeatureFlagKey {
  return (PRACTICE_FEATURE_FLAGS as readonly string[]).includes(key);
}
