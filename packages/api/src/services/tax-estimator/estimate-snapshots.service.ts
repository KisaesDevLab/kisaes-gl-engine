// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 12 — immutable estimate snapshots (MODULE.md "Scenarios,
// snapshots, standards"). Finalize computes the estimate FRESH (cache bypassed) and
// freezes: the inputs it read, the engine result, the resolved federal parameters and
// state rules with statuses, books readiness and its warnings, the assumptions block
// and the firm disclaimer in effect, plus who and when.
//
// Immutability (TE_SNAPSHOT_IMMUTABLE): this service has no update or delete path; the
// routes answer 409 to PUT / PATCH / DELETE; and a BEFORE UPDATE trigger rejects any
// change except re-encryption of the ciphertext columns by the key-rotation sweep.
// The plaintext sha256 is checked on every read, so a swapped ciphertext is detected.
//
// D9 / §7216: the payload holds prior-year tax / AGI and figures derived from them, so
// it is AES-256-GCM ciphertext in `payload_encrypted` / `summary_encrypted` (utils/
// encryption.ts; enrolled in the re-encryption sweep by the column names). Large JSON
// never goes to Redis. The read-only view redacts the raw prior-year inputs (they
// leave the service only on the single-year GET); the frozen result is returned as is.
//
// D1: a snapshot records the books tenants it includes; a caller whose scope no longer
// reaches one of them sees the history row without figures and gets 404 on view /
// compare.
import { createHash } from 'node:crypto';
import { and, count, desc, eq, gte } from 'drizzle-orm';
import type {
  EstimateReadinessDTO, EstimateResultDTO, EstimateSnapshotDTO, EstimateSnapshotInputsDTO, EstimateSnapshotListDTO,
  EstimateSnapshotListItemDTO, EstimateSnapshotPayload, EstimateSummaryDTO, SnapshotCompareDTO, SnapshotDiffRowDTO,
  SnapshotParameterChangeDTO, SnapshotReason, SnapshotsQuery, TaxEstimatorWarning, FilingStatus,
} from '@kis-books/shared';
import { buildEstimateAssumptions, dSub } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { taxEstSnapshots } from '../../db/schema/tax-estimator-estimate.js';
import { taxEstTaxpayers } from '../../db/schema/tax-estimator-taxpayers.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { AppError } from '../../utils/errors.js';
import { isTenantInScope, visibleTaxpayerFilter, type FirmScope } from './firm-scope.service.js';
import { computeEstimate, computeEstimateWithInputs, getEstimateReadiness, type EstimateInputsForSnapshot, type EstimateOptions } from './estimate.service.js';
import { auditYears, loadTaxpayerForFirm, type Actor } from './year-access.js';

type Row = typeof taxEstSnapshots.$inferSelect;

/** Encrypted payload ceiling; a larger estimate is refused rather than truncated. */
const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;

export const snapshotNotFound = () => new AppError(404, 'Snapshot not found', 'TE_SNAPSHOT_NOT_FOUND');
export const snapshotImmutable = () => new AppError(409, 'Tax estimate snapshots are immutable; finalize a new snapshot instead', 'TE_SNAPSHOT_IMMUTABLE');

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export interface CreateSnapshotRequest {
  taxpayerId: string;
  taxYear: number;
  scenarioId: string;
  throughMonth?: string;
  reason?: SnapshotReason;
  note?: string | null;
}

function inputsOf(i: EstimateInputsForSnapshot, throughMonth: string | null): EstimateSnapshotInputsDTO {
  return {
    throughMonth,
    taxpayer: { id: i.taxpayer.id, displayName: i.taxpayer.displayName, filingStatus: i.taxpayer.filingStatus as FilingStatus, residentState: i.taxpayer.residentState ?? null },
    year: i.year.year as unknown as Record<string, unknown>,
    safeHarbor: { rule: i.year.rule, ruleSource: i.year.ruleSource },
    persons: i.persons, links: i.links, companies: i.companies, adjustments: i.adjustments, adjustmentTypes: i.types,
    stateRows: i.stateRows, payments: i.payments, schAiFigures: i.schAiFigures,
  };
}

/** Every books tenant the snapshot's figures came from (D1 gate on view / compare). */
function tenantsOf(i: EstimateInputsForSnapshot, r: EstimateResultDTO): string[] {
  const ids = new Set<string>();
  for (const c of i.companies) ids.add(c.tenantId);
  for (const l of i.links) ids.add(l.tenantId);
  for (const e of r.entities) ids.add(e.tenantId);
  for (const a of i.adjustments) if (a.tenantId) ids.add(a.tenantId);
  for (const p of i.payments) if (p.tenantId) ids.add(p.tenantId);
  return [...ids].sort();
}

function auditShape(r: Row) {
  // Never the payload or summary (tax return information): metadata only.
  return {
    taxpayerId: r.taxpayerId, taxYear: r.taxYear, scenarioId: r.scenarioId, scenarioName: r.scenarioName, reason: r.reason, note: r.note,
    engineVersion: r.engineVersion, inputsHash: r.inputsHash, payloadSha256: r.payloadSha256, payloadBytes: r.payloadBytes,
  };
}

/** Reasons whose snapshots are only the record of a printout, so an identical one may be reused (R4-09). */
const REUSABLE_REASONS: readonly SnapshotReason[] = ['pdf', 'report_pack'];

/**
 * R4-09: the newest snapshot this user froze TODAY (UTC) for the same reason, scenario and
 * inputs. `inputsHash` covers the engine version, the firm scope, the request (incl. the
 * through month), the books' GL stamps, every input row, the parameters and the firm
 * settings (disclaimer) and the as-of day — so a match prints exactly the same figures.
 */
async function reusableSnapshot(scope: FirmScope, actor: Actor, req: CreateSnapshotRequest, reason: SnapshotReason, inputsHash: string): Promise<Row | null> {
  if (!REUSABLE_REASONS.includes(reason)) return null;
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db.select().from(taxEstSnapshots).where(and(
    eq(taxEstSnapshots.firmId, scope.firmId), eq(taxEstSnapshots.taxpayerId, req.taxpayerId), eq(taxEstSnapshots.taxYear, req.taxYear),
    eq(taxEstSnapshots.scenarioId, req.scenarioId), eq(taxEstSnapshots.reason, reason), eq(taxEstSnapshots.inputsHash, inputsHash),
    eq(taxEstSnapshots.createdBy, actor.userId), gte(taxEstSnapshots.createdAt, dayStart),
  )).orderBy(desc(taxEstSnapshots.createdAt)).limit(1);
  return row && accessible(scope, row) ? row : null;
}

export interface CreateSnapshotBehaviour {
  /** R4-09: reuse an identical same-day 'pdf' / 'report_pack' snapshot instead of freezing another (≤ 12 MB each). */
  reuseSameDay?: boolean;
}

/** Finalize: compute fresh, freeze, audit. Also called when vouchers are issued / a PDF or Report Pack section is generated. */
export async function createSnapshot(
  scope: FirmScope, actor: Actor, req: CreateSnapshotRequest, opts: EstimateOptions = {}, behaviour: CreateSnapshotBehaviour = {},
): Promise<EstimateSnapshotDTO> {
  await loadTaxpayerForFirm(scope, req.taxpayerId);
  const { result, inputs } = await computeEstimateWithInputs(scope, {
    taxpayerId: req.taxpayerId, taxYear: req.taxYear, scenarioId: req.scenarioId, throughMonth: req.throughMonth, refresh: true,
  }, opts);
  if (behaviour.reuseSameDay) {
    const existing = await reusableSnapshot(scope, actor, req, req.reason ?? 'finalize', result.inputsHash);
    if (existing) {
      const payload = readPayload(existing);
      return { ...listItem(scope, existing, payload.result.summary), payloadSha256: existing.payloadSha256, payload: redactForView(payload) };
    }
  }
  let readiness: EstimateReadinessDTO | null = null;
  try {
    readiness = await getEstimateReadiness(scope, req.taxpayerId, req.taxYear, { today: opts.today });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  const assumptions = result.assumptions ?? buildEstimateAssumptions(result, { disclaimerText: inputs.firmSettings.effectiveDisclaimerText });
  const payload: EstimateSnapshotPayload = {
    version: 1,
    inputs: inputsOf(inputs, req.throughMonth ?? null),
    federalParameters: inputs.federalParameters,
    stateRules: inputs.stateRules,
    result: { ...result, cached: false, assumptions },
    readiness,
    readinessWarnings: result.warnings,
    assumptions,
    disclaimerText: inputs.firmSettings.effectiveDisclaimerText,
    firmSettings: inputs.firmSettings,
  };
  const plain = JSON.stringify(payload);
  const bytes = Buffer.byteLength(plain, 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw AppError.unprocessableEntity(`The estimate is too large to snapshot (${bytes} bytes)`, 'TE_SNAPSHOT_TOO_LARGE');
  }
  const summaryPlain = JSON.stringify(result.summary);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(taxEstSnapshots).values({
      firmId: scope.firmId, taxpayerId: req.taxpayerId, taxYear: req.taxYear, scenarioId: req.scenarioId,
      scenarioName: inputs.scenarioName.slice(0, 120), reason: req.reason ?? 'finalize', note: req.note ?? null,
      engineVersion: result.engineVersion, inputsHash: result.inputsHash, tenantIds: tenantsOf(inputs, result),
      payloadEncrypted: encrypt(plain), payloadSha256: sha256(plain),
      summaryEncrypted: encrypt(summaryPlain), summarySha256: sha256(summaryPlain),
      payloadBytes: bytes, createdBy: actor.userId,
    }).returning();
    if (!row) throw new AppError(500, 'Snapshot insert failed', 'TE_SNAPSHOT_SAVE_FAILED');
    await auditYears(scope, actor, 'create', 'tax_est_snapshot', row.id, null, auditShape(row), tx);
    return { ...listItem(scope, row, result.summary), payloadSha256: row.payloadSha256, payload: redactForView(payload) };
  });
}

function accessible(scope: FirmScope, r: Row): boolean {
  return r.tenantIds.every((t) => isTenantInScope(scope, t));
}

function verifiedDecrypt(ciphertext: string, expectedSha: string): string {
  let plain: string;
  try {
    plain = decrypt(ciphertext);
  } catch {
    throw new AppError(500, 'Snapshot could not be decrypted with this server\'s key', 'TE_SNAPSHOT_UNREADABLE');
  }
  if (sha256(plain) !== expectedSha) throw new AppError(500, 'Snapshot integrity check failed', 'TE_SNAPSHOT_INTEGRITY');
  return plain;
}

function listItem(scope: FirmScope, r: Row, summary?: EstimateSummaryDTO | null): EstimateSnapshotListItemDTO {
  const ok = accessible(scope, r);
  let s: EstimateSummaryDTO | null = null;
  if (ok) s = summary ?? (JSON.parse(verifiedDecrypt(r.summaryEncrypted, r.summarySha256)) as EstimateSummaryDTO);
  return {
    id: r.id, taxpayerId: r.taxpayerId, taxYear: r.taxYear, scenarioId: r.scenarioId, scenarioName: r.scenarioName,
    reason: r.reason as SnapshotReason, note: r.note, engineVersion: r.engineVersion, inputsHash: r.inputsHash.trim(),
    createdBy: r.createdBy, createdAt: r.createdAt.toISOString(), accessible: ok, summary: s,
  };
}

/** View copy: the raw prior-year federal and state tax / AGI inputs are withheld (D9); the *_Present flags stay. */
function redactForView(p: EstimateSnapshotPayload): EstimateSnapshotPayload {
  const year = { ...p.inputs.year, priorYearTax: null, priorYearAgi: null };
  const stateRows = (p.inputs.stateRows as Array<{ dto?: unknown }>).map((r) => r.dto ?? r);
  return { ...p, inputs: { ...p.inputs, year, stateRows } };
}

/** GET .../snapshots — history, newest first, paged with a total. */
export async function listSnapshots(scope: FirmScope, taxpayerId: string, taxYear: number, q: SnapshotsQuery): Promise<EstimateSnapshotListDTO> {
  await loadTaxpayerForFirm(scope, taxpayerId);
  const where = and(
    eq(taxEstSnapshots.firmId, scope.firmId), eq(taxEstSnapshots.taxpayerId, taxpayerId), eq(taxEstSnapshots.taxYear, taxYear),
    q.scenarioId ? eq(taxEstSnapshots.scenarioId, q.scenarioId) : undefined,
  );
  const [rows, [tot]] = await Promise.all([
    db.select().from(taxEstSnapshots).where(where).orderBy(desc(taxEstSnapshots.createdAt), desc(taxEstSnapshots.id)).limit(q.limit).offset(q.offset),
    db.select({ n: count() }).from(taxEstSnapshots).where(where),
  ]);
  return { data: rows.map((r) => listItem(scope, r)), total: Number(tot?.n ?? 0), limit: q.limit, offset: q.offset };
}

/** By id: the firm AND the taxpayer's D17 visibility; a hidden taxpayer's snapshot is the same 404 as another firm's. */
async function loadSnapshotRow(scope: FirmScope, snapshotId: string): Promise<Row> {
  const [hit] = await db.select({ s: taxEstSnapshots }).from(taxEstSnapshots)
    .innerJoin(taxEstTaxpayers, eq(taxEstTaxpayers.id, taxEstSnapshots.taxpayerId))
    .where(and(eq(taxEstSnapshots.id, snapshotId), eq(taxEstSnapshots.firmId, scope.firmId), visibleTaxpayerFilter(scope)));
  const row = hit?.s;
  if (!row) throw snapshotNotFound();
  if (!accessible(scope, row)) throw new AppError(404, 'The snapshot includes a client your firm no longer manages (or you can no longer reach)', 'TE_TENANT_NOT_MANAGED');
  return row;
}

function readPayload(row: Row): EstimateSnapshotPayload {
  return JSON.parse(verifiedDecrypt(row.payloadEncrypted, row.payloadSha256)) as EstimateSnapshotPayload;
}

/** GET /snapshots/:id — the read-only view. */
export async function getSnapshot(scope: FirmScope, snapshotId: string): Promise<EstimateSnapshotDTO> {
  const row = await loadSnapshotRow(scope, snapshotId);
  const payload = readPayload(row);
  return { ...listItem(scope, row, payload.result.summary), payloadSha256: row.payloadSha256, payload: redactForView(payload) };
}

// ── Compare with live ───────────────────────────────────────────────────

type Lines = Map<string, { label: string; value: string }>;

/** Money lines compared snapshot vs live (paths into EstimateResultDTO). */
function linesOf(r: EstimateResultDTO): Lines {
  const m: Lines = new Map();
  const put = (path: string, label: string, v: string | null | undefined) => { if (v != null) m.set(path, { label, value: String(v) }); };
  const s = r.summary;
  put('summary.federalTotal', 'Federal total tax', s.federalTotal);
  put('summary.stateTotal', 'State total tax', s.stateTotal);
  put('summary.total', 'Total tax', s.total);
  put('summary.federalRequiredAnnualPayment', 'Federal required annual payment', s.federalRequiredAnnualPayment);
  put('summary.federalUnpaid', 'Federal unpaid', s.federalUnpaid);
  put('summary.federalPenalty', 'Federal penalty', s.federalPenalty);
  put('summary.statePenalty', 'State penalty', s.statePenalty);
  put('summary.marginalRate', 'Marginal rate', s.marginalRate);
  const f = r.federal;
  put('federal.income.totalIncome', 'Total income', f.income.totalIncome);
  put('federal.agi', 'AGI', f.agi);
  put('federal.deductions.deduction', 'Deduction', f.deductions.deduction);
  put('federal.qbi.deduction', 'QBI deduction', f.qbi.deduction);
  put('federal.taxableIncome', 'Taxable income', f.taxableIncome);
  put('federal.regularTax.tax', 'Income tax', f.regularTax.tax);
  put('federal.seTax', 'Self-employment tax', f.seTax);
  put('federal.additionalMedicareTax', 'Additional Medicare tax', f.additionalMedicareTax);
  put('federal.niit', 'Net investment income tax', f.niit);
  for (const e of f.entities) put(`federal.entities.${e.companyId}.projectedProfit`, `${e.companyName} projected profit`, e.projectedProfit);
  for (const row of r.state?.rows ?? []) put(`state.${row.state}.netTax`, `${row.state} net tax`, row.netTax);
  for (const j of [r.federalEstimates, ...r.stateEstimates]) {
    const name = j.jurisdiction === 'federal' ? 'Federal' : j.jurisdiction;
    // QA D24: the federal figure is already the summary line; list it once.
    if (j.jurisdiction !== 'federal') put(`estimates.${j.jurisdiction}.requiredAnnualPayment`, `${name} required annual payment`, j.safeHarbor.requiredAnnualPayment);
    for (const i of j.installments) {
      put(`estimates.${j.jurisdiction}.${i.label}.required`, `${name} ${i.label} required`, i.required);
      put(`estimates.${j.jurisdiction}.${i.label}.unpaid`, `${name} ${i.label} unpaid`, i.unpaid);
    }
  }
  return m;
}

const isNumeric = (v: string | null) => v != null && /^-?\d+(\.\d+)?$/.test(v);

function diffLines(snap: EstimateResultDTO, live: EstimateResultDTO): SnapshotDiffRowDTO[] {
  const a = linesOf(snap);
  const b = linesOf(live);
  const out: SnapshotDiffRowDTO[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])]) {
    const sv = a.get(path)?.value ?? null;
    const lv = b.get(path)?.value ?? null;
    if (sv === lv) continue;
    out.push({
      path, label: a.get(path)?.label ?? b.get(path)!.label, snapshot: sv, live: lv,
      delta: isNumeric(sv) && isNumeric(lv) ? dSub(lv!, sv!) : null,
    });
  }
  return out;
}

function paramChanges(snap: EstimateResultDTO, live: EstimateResultDTO): SnapshotParameterChangeDTO[] {
  const key = (scope: string, k: string) => `${scope}|${k}`;
  const toMap = (r: EstimateResultDTO) => {
    const m = new Map<string, { scope: string; key: string; value: unknown; status: string }>();
    for (const p of r.parametersUsed) m.set(key('federal', p.key), { scope: 'federal', key: p.key, value: p.value, status: p.status });
    for (const u of r.rulesUsed) m.set(key(u.state, u.key), { scope: u.state, key: u.key, value: u.value, status: u.status });
    return m;
  };
  const a = toMap(snap);
  const b = toMap(live);
  const out: SnapshotParameterChangeDTO[] = [];
  for (const k of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(k);
    const y = b.get(k);
    if (x && y && x.status === y.status && JSON.stringify(x.value) === JSON.stringify(y.value)) continue;
    const ref = (x ?? y)!;
    out.push({ scope: ref.scope, key: ref.key, snapshot: x ? { value: x.value, status: x.status } : null, live: y ? { value: y.value, status: y.status } : null });
  }
  return out;
}

function warningDiff(a: TaxEstimatorWarning[], b: TaxEstimatorWarning[]): TaxEstimatorWarning[] {
  const have = new Set(b.map((w) => `${w.code}|${w.message}`));
  return a.filter((w) => !have.has(`${w.code}|${w.message}`));
}

/** GET /snapshots/:id/compare — the frozen result vs a live computation of the same scenario and range. */
export async function compareSnapshot(scope: FirmScope, snapshotId: string, opts: EstimateOptions = {}): Promise<SnapshotCompareDTO> {
  const row = await loadSnapshotRow(scope, snapshotId);
  const payload = readPayload(row);
  const snap = payload.result;
  let live: EstimateResultDTO;
  try {
    live = await computeEstimate(scope, {
      taxpayerId: row.taxpayerId, taxYear: row.taxYear, scenarioId: row.scenarioId, throughMonth: payload.inputs.throughMonth ?? undefined,
    }, opts);
  } catch (err) {
    // R3-18: a deleted scenario (or any refused live compute) must not look like a missing
    // snapshot — return the frozen side with no live side.
    if (!(err instanceof AppError)) throw err;
    const message = err.code === 'TE_SCENARIO_NOT_FOUND'
      ? `The scenario "${row.scenarioName}" no longer exists, so there is no live estimate to compare with.`
      : `A live estimate could not be computed: ${err.message}`;
    return {
      snapshotId: row.id, snapshotCreatedAt: row.createdAt.toISOString(), liveComputedAt: null,
      liveUnavailable: { code: err.code ?? 'TE_LIVE_UNAVAILABLE', message },
      engineVersionChanged: false, inputsHashChanged: false,
      summary: { snapshot: snap.summary, live: null },
      differences: [], parameterChanges: [], warningsAdded: [], warningsRemoved: [],
    };
  }
  return {
    snapshotId: row.id, snapshotCreatedAt: row.createdAt.toISOString(), liveComputedAt: live.computedAt, liveUnavailable: null,
    engineVersionChanged: snap.engineVersion !== live.engineVersion, inputsHashChanged: snap.inputsHash !== live.inputsHash,
    summary: { snapshot: snap.summary, live: live.summary },
    differences: diffLines(snap, live),
    parameterChanges: paramChanges(snap, live),
    warningsAdded: warningDiff(live.warnings, snap.warnings),
    warningsRemoved: warningDiff(snap.warnings, live.warnings),
  };
}
