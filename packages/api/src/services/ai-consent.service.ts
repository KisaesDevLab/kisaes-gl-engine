// Two-tier AI consent service.
//
// See Build Plans/AI_PII_PROTECTION_ADDENDUM.md §Two-Tier Consent Model.
//
// Tier 1 (system / super-admin): ai_config.admin_disclosure_accepted_at
// must be set before ai_config.is_enabled can go TRUE. Controls which
// providers are available, the PII protection level, and the cloud-
// vision opt-in.
//
// Tier 2 (company / tenant-owner): companies.ai_enabled + per-task
// flags in companies.ai_enabled_tasks + accepted disclosure version.
// Follows the same shape as chatSupportEnabled (chat.service §60-99)
// so existing "is any company opted in" queries compose cleanly.

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiConfig, companies } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';

export type AiTaskKey = 'categorization' | 'receipt_ocr' | 'statement_parsing' | 'document_classification';

const ALL_TASK_KEYS: AiTaskKey[] = ['categorization', 'receipt_ocr', 'statement_parsing', 'document_classification'];

// Keep this text in the service so disclosure generation can be audited
// and version-bumped centrally. If the wording changes, increment
// SYSTEM_DISCLOSURE_TEXT_VERSION below — consent is re-required when
// this version moves forward (separate axis from ai_config.disclosure_
// version, which tracks data-flow-affecting config changes).
export const SYSTEM_DISCLOSURE_TEXT_VERSION = 1;

const SYSTEM_DISCLOSURE_MARKDOWN = `# AI Processing Data Disclosure

By enabling AI processing for this Vibe MyBooks installation, you acknowledge:

**What data is sent to external services:**
- Sanitized transaction descriptions from bank feeds (personal names in Venmo/Zelle/PayPal/Cash App entries are redacted before sending)
- Text extracted from uploaded receipts, invoices, and bank statements (sanitized based on your PII protection level)
- Your chart of accounts names (used for categorization context)

**What data is NEVER sent to external services:**
- Complete bank account numbers, routing numbers, or SSN/EIN
- Raw document images (unless you explicitly enable cloud vision in Permissive mode)
- Aggregate financial data, balances, or reports
- User passwords or authentication credentials

**When using self-hosted models (Ollama / GLM-OCR local):**
- No data leaves your server. All processing is local.

**You can disable AI processing at any time.** Disabling does not affect existing transactions or bookkeeping data.`;

// The list of providers currently considered "self-hosted" — data does
// not leave the server for these. Keep in sync with
// ai-orchestrator.service isSelfHostedProvider().
const SELF_HOSTED = new Set(['ollama', 'glm_ocr_local']);

function isSelfHosted(providerName: string | null | undefined): boolean {
  return !!providerName && SELF_HOSTED.has(providerName);
}

// ─── System disclosure ─────────────────────────────────────────

export async function getSystemDisclosure(): Promise<{
  version: number;
  textVersion: number;
  text: string;
  acceptedAt: Date | null;
  acceptedBy: string | null;
}> {
  const config = await db.query.aiConfig.findFirst();
  return {
    version: config?.disclosureVersion ?? 1,
    textVersion: SYSTEM_DISCLOSURE_TEXT_VERSION,
    text: SYSTEM_DISCLOSURE_MARKDOWN,
    acceptedAt: config?.adminDisclosureAcceptedAt ?? null,
    acceptedBy: config?.adminDisclosureAcceptedBy ?? null,
  };
}

export async function acceptSystemDisclosure(userId: string): Promise<void> {
  const config = await db.query.aiConfig.findFirst();
  if (!config) {
    // No row yet — create with acceptance recorded.
    await db.insert(aiConfig).values({
      adminDisclosureAcceptedAt: new Date(),
      adminDisclosureAcceptedBy: userId,
    });
  } else {
    await db.update(aiConfig).set({
      adminDisclosureAcceptedAt: new Date(),
      adminDisclosureAcceptedBy: userId,
      updatedAt: new Date(),
    }).where(eq(aiConfig.id, config.id));
  }
  // Audit against a system-scoped "tenant" — we use the all-zero UUID
  // as a sentinel for system-level actions, same convention the rest
  // of the admin code paths use. Non-tenanted audit rows are fine
  // here because the admin identity is captured in userId.
  await auditLog(
    '00000000-0000-0000-0000-000000000000',
    'update',
    'ai_config_system_disclosure',
    null,
    null,
    { acceptedAt: new Date().toISOString(), acceptedBy: userId },
    userId,
  );
}

export async function isSystemDisclosureAccepted(): Promise<boolean> {
  const config = await db.query.aiConfig.findFirst();
  return !!config?.adminDisclosureAcceptedAt;
}

// ─── Invalidation ──────────────────────────────────────────────
//
// A config change "loosens data handling" when it causes data to flow
// somewhere it did not before, OR to a provider with a different data
// policy than the one the owner last accepted.

export interface DataFlowSnapshot {
  isEnabled: boolean;
  categorizationProvider: string | null;
  ocrProvider: string | null;
  documentClassificationProvider: string | null;
  chatProvider: string | null;
  piiProtectionLevel: string;
  cloudVisionEnabled: boolean;
}

export async function snapshotDataFlow(): Promise<DataFlowSnapshot> {
  const config = await db.query.aiConfig.findFirst();
  return {
    isEnabled: !!config?.isEnabled,
    categorizationProvider: config?.categorizationProvider ?? null,
    ocrProvider: config?.ocrProvider ?? null,
    documentClassificationProvider: config?.documentClassificationProvider ?? null,
    chatProvider: config?.chatProvider ?? null,
    piiProtectionLevel: config?.piiProtectionLevel ?? 'strict',
    cloudVisionEnabled: !!config?.cloudVisionEnabled,
  };
}

/**
 * Compare two data-flow snapshots and decide whether the change
 * invalidates company-level consent. Returns a reason string when a
 * bump is required, or null when the change is more protective.
 *
 * See addendum §Re-Consent Trigger for the rules.
 */
export function changeRequiresReconsent(prev: DataFlowSnapshot, next: DataFlowSnapshot): string | null {
  // Re-enabling AI after it was off resumes data flow — companies
  // should re-accept to confirm they're aware.
  if (!prev.isEnabled && next.isEnabled) {
    return 'ai_reactivated';
  }
  // PII level: strict → permissive or standard → permissive loosens.
  // Anything → strict is more protective.
  if (prev.piiProtectionLevel !== next.piiProtectionLevel) {
    if (next.piiProtectionLevel === 'permissive' && prev.piiProtectionLevel !== 'permissive') {
      return 'pii_protection_level_loosened';
    }
  }
  // Cloud vision: turning on requires re-consent.
  if (!prev.cloudVisionEnabled && next.cloudVisionEnabled) {
    return 'cloud_vision_enabled';
  }
  // Provider change per task. Self-hosted → cloud bumps; cloud →
  // self-hosted is more protective; cloud → different cloud bumps
  // (different data policy).
  const pairs: Array<[string, string | null, string | null]> = [
    ['categorization', prev.categorizationProvider, next.categorizationProvider],
    ['ocr', prev.ocrProvider, next.ocrProvider],
    ['document_classification', prev.documentClassificationProvider, next.documentClassificationProvider],
  ];
  for (const [task, a, b] of pairs) {
    if (a === b) continue;
    // Dropping a provider entirely doesn't expose more data.
    if (a && !b) continue;
    // Adding a provider where there was none, or switching providers.
    if (!a && b) {
      if (!isSelfHosted(b)) return `${task}_provider_added_cloud`;
      continue;
    }
    if (a && b) {
      if (isSelfHosted(a) && !isSelfHosted(b)) return `${task}_provider_local_to_cloud`;
      if (!isSelfHosted(a) && isSelfHosted(b)) continue; // cloud → local is more protective
      if (!isSelfHosted(a) && !isSelfHosted(b)) return `${task}_provider_cloud_switch`;
      // self-hosted → different self-hosted: treat as no-op
    }
  }
  return null;
}

/**
 * Bump ai_config.disclosure_version and return the new value. Callers
 * (ai-config.service on config update) pass the `reason` so the audit
 * row explains which change triggered the bump.
 */
export async function invalidateCompanyConsent(reason: string, userId?: string): Promise<number> {
  const config = await db.query.aiConfig.findFirst();
  if (!config) return 1;
  const prev = config.disclosureVersion ?? 1;
  const [updated] = await db.update(aiConfig).set({
    disclosureVersion: sql`COALESCE(disclosure_version, 1) + 1`,
    updatedAt: new Date(),
  }).where(eq(aiConfig.id, config.id)).returning({ disclosureVersion: aiConfig.disclosureVersion });
  const next = updated?.disclosureVersion ?? prev + 1;
  await auditLog(
    '00000000-0000-0000-0000-000000000000',
    'update',
    'ai_config_disclosure_version',
    null,
    { version: prev },
    { version: next, reason },
    userId,
  );
  return next;
}

// ─── Company disclosure ────────────────────────────────────────

export interface CompanyDisclosure {
  companyId: string;
  companyName: string;
  systemVersion: number;
  acceptedVersion: number | null;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  aiEnabled: boolean;
  enabledTasks: Record<AiTaskKey, boolean>;
  currentConfig: {
    piiProtectionLevel: string;
    categorizationProvider: string | null;
    ocrProvider: string | null;
    documentClassificationProvider: string | null;
  };
  text: string;
  isStale: boolean;
}

export async function getCompanyDisclosure(tenantId: string, companyId: string): Promise<CompanyDisclosure> {
  const [company] = await db.select().from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
  if (!company) throw AppError.notFound('Company not found');

  const cfg = await db.query.aiConfig.findFirst();
  const systemVersion = cfg?.disclosureVersion ?? 1;
  const pii = (cfg?.piiProtectionLevel ?? 'strict') as string;

  const tasks = (company.aiEnabledTasks as Record<AiTaskKey, boolean>) || {
    categorization: false, receipt_ocr: false, statement_parsing: false, document_classification: false,
  };

  const text = renderCompanyDisclosure({
    companyName: company.businessName,
    piiProtectionLevel: pii,
    categorizationProvider: cfg?.categorizationProvider ?? null,
    ocrProvider: cfg?.ocrProvider ?? null,
    documentClassificationProvider: cfg?.documentClassificationProvider ?? null,
    tasks,
  });

  const acceptedVersion = company.aiDisclosureVersion ?? null;
  const isStale = !!company.aiEnabled && (acceptedVersion === null || acceptedVersion < systemVersion);

  return {
    companyId: company.id,
    companyName: company.businessName,
    systemVersion,
    acceptedVersion,
    acceptedAt: company.aiDisclosureAcceptedAt ?? null,
    acceptedBy: company.aiDisclosureAcceptedBy ?? null,
    aiEnabled: !!company.aiEnabled,
    enabledTasks: tasks,
    currentConfig: {
      piiProtectionLevel: pii,
      categorizationProvider: cfg?.categorizationProvider ?? null,
      ocrProvider: cfg?.ocrProvider ?? null,
      documentClassificationProvider: cfg?.documentClassificationProvider ?? null,
    },
    text,
    isStale,
  };
}

function providerLabel(p: string | null): string {
  if (!p) return 'not configured';
  switch (p) {
    case 'anthropic': return 'Anthropic Claude';
    case 'openai': return 'OpenAI';
    case 'gemini': return 'Google Gemini';
    case 'ollama': return 'Ollama (self-hosted)';
    case 'glm_ocr_local': return 'GLM-OCR (self-hosted)';
    case 'glm_ocr_cloud': return 'GLM-OCR Cloud';
    default: return p;
  }
}

function renderCompanyDisclosure(args: {
  companyName: string;
  piiProtectionLevel: string;
  categorizationProvider: string | null;
  ocrProvider: string | null;
  documentClassificationProvider: string | null;
  tasks: Record<AiTaskKey, boolean>;
}): string {
  return [
    `# AI Processing Consent for ${args.companyName}`,
    ``,
    `By enabling AI processing for **${args.companyName}**, you consent to the following:`,
    ``,
    `**Current system configuration:**`,
    `- PII Protection Level: **${args.piiProtectionLevel}**`,
    `- Categorization Provider: ${providerLabel(args.categorizationProvider)}`,
    `- OCR Provider: ${providerLabel(args.ocrProvider)}`,
    `- Document Classification Provider: ${providerLabel(args.documentClassificationProvider)}`,
    ``,
    `**What is sent to external services:**`,
    `- Sanitized transaction descriptions, amounts, and dates`,
    `- OCR-extracted text (never raw images, unless PII protection is set to Permissive and cloud vision is explicitly enabled)`,
    `- Your chart of accounts names`,
    ``,
    `**What is never sent:**`,
    `- Complete bank account numbers, routing numbers, SSN/EIN`,
    `- Personal names in Venmo/Zelle/PayPal/Cash App descriptions`,
    `- Raw document images under Strict or Standard protection`,
    ``,
    `**Your data controls:**`,
    `- Disable AI at any time from this settings page`,
    `- Enable or disable individual tasks independently`,
    `- All AI suggestions require your review before affecting your books`,
    ``,
    `If the system administrator changes the AI configuration in a way that loosens data handling, this consent will be paused until you review and re-accept.`,
  ].join('\n');
}

export async function acceptCompanyDisclosure(tenantId: string, companyId: string, userId: string): Promise<CompanyDisclosure> {
  const cfg = await db.query.aiConfig.findFirst();
  if (!cfg?.isEnabled) throw AppError.badRequest('AI processing is not enabled at the system level.');
  if (!cfg.adminDisclosureAcceptedAt) throw AppError.badRequest('System administrator has not accepted the AI disclosure yet.');

  const [before] = await db.select().from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
  if (!before) throw AppError.notFound('Company not found');

  const version = cfg.disclosureVersion ?? 1;
  const now = new Date();
  await db.update(companies).set({
    aiEnabled: true,
    aiDisclosureAcceptedAt: now,
    aiDisclosureAcceptedBy: userId,
    aiDisclosureVersion: version,
    updatedAt: now,
  }).where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));

  await auditLog(
    tenantId,
    'update',
    'company_ai_consent_accepted',
    companyId,
    { aiEnabled: before.aiEnabled, version: before.aiDisclosureVersion },
    { aiEnabled: true, version },
    userId,
  );

  return getCompanyDisclosure(tenantId, companyId);
}

export async function revokeCompanyConsent(tenantId: string, companyId: string, userId: string): Promise<void> {
  const [before] = await db.select().from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
  if (!before) throw AppError.notFound('Company not found');

  await db.update(companies).set({
    aiEnabled: false,
    aiEnabledTasks: { categorization: false, receipt_ocr: false, statement_parsing: false, document_classification: false },
    aiDisclosureAcceptedAt: null,
    aiDisclosureAcceptedBy: null,
    aiDisclosureVersion: null,
    updatedAt: new Date(),
  }).where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));

  await auditLog(
    tenantId,
    'update',
    'company_ai_consent_revoked',
    companyId,
    { aiEnabled: before.aiEnabled, tasks: before.aiEnabledTasks, version: before.aiDisclosureVersion },
    { aiEnabled: false },
    userId,
  );
}

export async function setCompanyTaskToggles(
  tenantId: string,
  companyId: string,
  toggles: Partial<Record<AiTaskKey, boolean>>,
  userId: string,
): Promise<Record<AiTaskKey, boolean>> {
  const [company] = await db.select().from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
  if (!company) throw AppError.notFound('Company not found');
  if (!company.aiEnabled) throw AppError.badRequest('Company has not opted in to AI processing.');

  const before = (company.aiEnabledTasks as Record<AiTaskKey, boolean>) || {
    categorization: false, receipt_ocr: false, statement_parsing: false, document_classification: false,
  };
  const next: Record<AiTaskKey, boolean> = { ...before };
  for (const key of ALL_TASK_KEYS) {
    if (toggles[key] !== undefined) next[key] = !!toggles[key];
  }

  await db.update(companies).set({
    aiEnabledTasks: next,
    updatedAt: new Date(),
  }).where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));

  await auditLog(
    tenantId,
    'update',
    'company_ai_tasks',
    companyId,
    before,
    next,
    userId,
  );

  return next;
}

// ─── Orchestrator-facing checks ────────────────────────────────

export interface ConsentCheckResult {
  allowed: boolean;
  reason?: 'system_disabled' | 'system_disclosure_not_accepted' | 'company_not_opted_in' | 'task_disabled' | 'consent_stale';
  companyId?: string;
}

/**
 * Per-tenant consent gate for a given task. Follows the chat.service
 * pattern: "is there at least one company in this tenant with AI
 * enabled, consent current, and this task toggled on?"
 *
 * Returns the first matching company's id on success so the caller
 * can record which company's consent authorized the job.
 */
export async function checkTenantTaskConsent(tenantId: string, task: AiTaskKey): Promise<ConsentCheckResult> {
  const cfg = await db.query.aiConfig.findFirst();
  if (!cfg?.isEnabled) return { allowed: false, reason: 'system_disabled' };
  if (!cfg.adminDisclosureAcceptedAt) return { allowed: false, reason: 'system_disclosure_not_accepted' };

  const systemVersion = cfg.disclosureVersion ?? 1;

  // Task-keyed JSONB path: companies.ai_enabled_tasks ->> task = 'true'.
  const rows = await db.select({
    id: companies.id,
    aiEnabled: companies.aiEnabled,
    version: companies.aiDisclosureVersion,
    tasks: companies.aiEnabledTasks,
  }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.aiEnabled, true)));

  if (rows.length === 0) return { allowed: false, reason: 'company_not_opted_in' };

  // Find a company with current consent AND this task toggled on.
  let staleSeen = false;
  let taskDisabledSeen = false;
  for (const row of rows) {
    const version = row.version ?? 0;
    if (version < systemVersion) { staleSeen = true; continue; }
    const tasks = (row.tasks as Record<AiTaskKey, boolean>) || {};
    if (!tasks[task]) { taskDisabledSeen = true; continue; }
    return { allowed: true, companyId: row.id };
  }

  // Ordering of reasons: stale > task-disabled. Stale is the thing the
  // user needs to act on first — if they re-accept and the task is
  // still off, they'll get a second clear message.
  if (staleSeen) return { allowed: false, reason: 'consent_stale' };
  if (taskDisabledSeen) return { allowed: false, reason: 'task_disabled' };
  return { allowed: false, reason: 'company_not_opted_in' };
}

/**
 * Consent summary for a tenant — returns per-company status so the
 * settings UI can render the full picture. Intentionally does not
 * include provider details (that's on the admin endpoints).
 */
export async function getTenantConsentStatus(tenantId: string) {
  const cfg = await db.query.aiConfig.findFirst();
  const systemEnabled = !!cfg?.isEnabled;
  const systemDisclosureAccepted = !!cfg?.adminDisclosureAcceptedAt;
  const systemVersion = cfg?.disclosureVersion ?? 1;

  const rows = await db.select({
    id: companies.id,
    businessName: companies.businessName,
    aiEnabled: companies.aiEnabled,
    version: companies.aiDisclosureVersion,
    tasks: companies.aiEnabledTasks,
    acceptedAt: companies.aiDisclosureAcceptedAt,
  }).from(companies).where(eq(companies.tenantId, tenantId));

  return {
    systemEnabled,
    systemDisclosureAccepted,
    systemVersion,
    piiProtectionLevel: cfg?.piiProtectionLevel ?? 'strict',
    categorizationProvider: cfg?.categorizationProvider ?? null,
    ocrProvider: cfg?.ocrProvider ?? null,
    documentClassificationProvider: cfg?.documentClassificationProvider ?? null,
    companies: rows.map((r) => ({
      id: r.id,
      name: r.businessName,
      aiEnabled: !!r.aiEnabled,
      acceptedVersion: r.version ?? null,
      acceptedAt: r.acceptedAt ?? null,
      tasks: (r.tasks as Record<AiTaskKey, boolean>) ?? null,
      isStale: !!r.aiEnabled && (r.version === null || (r.version ?? 0) < systemVersion),
    })),
  };
}

// Test hook: SQL expression used by integration tests that need to seed
// a consent state directly without going through the service. Using the
// constant keeps the test in sync with the service's canonical defaults.
export const DEFAULT_TASK_TOGGLES: Record<AiTaskKey, boolean> = {
  categorization: false,
  receipt_ocr: false,
  statement_parsing: false,
  document_classification: false,
};

// Exposed for ai-config.service so it can compose in a transaction.
export const __internal = { snapshotDataFlow, changeRequiresReconsent, invalidateCompanyConsent };
// Avoid "unused" lint: `sql` import keeps drizzle types visible even
// though we currently only use the drizzle builder API here.
export const __keepSql = sql;
