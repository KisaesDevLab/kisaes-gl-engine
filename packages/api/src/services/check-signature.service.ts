// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Check signature library: tenant-scoped signature images that print on the
// check face. Bytes are AES-256-GCM ciphertext on LOCAL disk under
// UPLOAD_DIR/signatures/<tenantId>/ — never routed through the tenant's
// pluggable storage provider, never served as a static /uploads URL. The
// only egress is the authenticated preview route and in-memory PDF embedding.
//
// Step-up: printing WITH a signature requires fresh re-authentication —
// the user's TOTP code when 2FA-enrolled, else their password. A success
// mints a short-lived JWT (checks_stepup claim) that the client passes on
// /render and /print; expiry of that token IS the grace window.

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { checkSignatures, checkSignatureUsers, users } from '../db/schema/index.js';
import { CHECK_SIGNATURE_MAX_WIDTH, CHECK_SIGNATURE_MAX_HEIGHT, type CheckSignature, type MySignature, type StepUpMethod } from '@kis-books/shared';
import { encryptBuffer, decryptBuffer } from '../utils/encryption.js';
import { sniffImageMime, imageDimensions } from '../utils/image-dimensions.js';
import { writeAtomicSync } from '../utils/atomic-write.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as tfaService from './tfa.service.js';
import * as authService from './auth.service.js';

const STEP_UP_TTL_SECONDS = 600; // 10-minute grace window

// Step-up tokens are signed with a key DERIVED from JWT_SECRET, not
// JWT_SECRET itself. authenticate() accepts any HS256 token signed with
// JWT_SECRET whose userId resolves, so a step-up token signed with the
// raw secret would double as a (role-less) session token — and vice
// versa an access token must never satisfy verifyStepUpToken. Distinct
// keys make the two token families mutually unverifiable.
function stepUpSecret(): Buffer {
  return crypto.createHmac('sha256', env.JWT_SECRET).update('check-signature-step-up').digest();
}

// Same role as auth.service's dummy hash: equalize bcrypt timing on the
// no-password branch so step-up can't be used to probe account state.
const DUMMY_PASSWORD_HASH =
  '$2b$12$CwTycUXWue0Thq9StjUM0uJ8lGwkE1dKtDSpFQNshLQ4uMRGjB3sC';

function signatureDir(tenantId: string): string {
  return path.join(env.UPLOAD_DIR, 'signatures', tenantId);
}

interface SignatureImageUpload { buffer: Buffer; mimetype: string }

function validateSignatureImage(file: SignatureImageUpload): { mime: 'image/png' | 'image/jpeg'; width: number; height: number } {
  const mime = sniffImageMime(file.buffer);
  if (!mime || (file.mimetype !== 'image/png' && file.mimetype !== 'image/jpeg') || mime !== file.mimetype) {
    throw AppError.badRequest('Signature must be a PNG or JPEG image', 'SIGNATURE_BAD_TYPE');
  }
  const dims = imageDimensions(file.buffer, mime);
  if (!dims) throw AppError.badRequest('Could not read image dimensions — the file appears malformed', 'SIGNATURE_BAD_IMAGE');
  if (dims.width > CHECK_SIGNATURE_MAX_WIDTH || dims.height > CHECK_SIGNATURE_MAX_HEIGHT) {
    throw AppError.badRequest(
      `Signature image is ${dims.width}×${dims.height}px — the maximum is ${CHECK_SIGNATURE_MAX_WIDTH}×${CHECK_SIGNATURE_MAX_HEIGHT}px. Please resize it and try again.`,
      'SIGNATURE_TOO_LARGE',
    );
  }
  return { mime, ...dims };
}

function storeImage(tenantId: string, id: string, buffer: Buffer): string {
  const relPath = path.join('signatures', tenantId, `${id}-${crypto.randomBytes(4).toString('hex')}.enc`);
  fs.mkdirSync(signatureDir(tenantId), { recursive: true });
  writeAtomicSync(path.join(env.UPLOAD_DIR, relPath), encryptBuffer(buffer));
  return relPath;
}

function unlinkQuietly(relPath: string): void {
  try { fs.unlinkSync(path.join(env.UPLOAD_DIR, relPath)); } catch { /* best-effort */ }
}

const publicShape = (s: typeof checkSignatures.$inferSelect, sigUsers: CheckSignature['users']): CheckSignature => ({
  id: s.id,
  label: s.label,
  mimeType: s.mimeType,
  width: s.width,
  height: s.height,
  maxAmount: s.maxAmount,
  isActive: s.isActive,
  createdAt: s.createdAt.toISOString(),
  users: sigUsers,
});

export async function listSignatures(tenantId: string): Promise<CheckSignature[]> {
  const sigs = await db.query.checkSignatures.findMany({
    where: and(eq(checkSignatures.tenantId, tenantId), eq(checkSignatures.isActive, true)),
    orderBy: (t, { asc }) => [asc(t.label)],
  });
  if (sigs.length === 0) return [];
  const mappings = await db
    .select({ signatureId: checkSignatureUsers.signatureId, id: users.id, displayName: users.displayName, email: users.email })
    .from(checkSignatureUsers)
    .innerJoin(users, eq(users.id, checkSignatureUsers.userId))
    .where(and(eq(checkSignatureUsers.tenantId, tenantId), inArray(checkSignatureUsers.signatureId, sigs.map((s) => s.id))));
  return sigs.map((s) => publicShape(s, mappings
    .filter((m) => m.signatureId === s.id)
    .map(({ id, displayName, email }) => ({ id, displayName: displayName ?? email, email }))));
}

/** Signatures the given user may print with. Owners/super-admins see the
 *  whole active library (they could assign themselves anyway). */
export async function listMySignatures(tenantId: string, userId: string, isOwner: boolean): Promise<MySignature[]> {
  const rows = isOwner
    ? await db.query.checkSignatures.findMany({
        where: and(eq(checkSignatures.tenantId, tenantId), eq(checkSignatures.isActive, true)),
        orderBy: (t, { asc }) => [asc(t.label)],
      })
    : await db
        .select({
          id: checkSignatures.id, label: checkSignatures.label, maxAmount: checkSignatures.maxAmount,
          width: checkSignatures.width, height: checkSignatures.height,
        })
        .from(checkSignatureUsers)
        .innerJoin(checkSignatures, eq(checkSignatures.id, checkSignatureUsers.signatureId))
        .where(and(
          eq(checkSignatureUsers.tenantId, tenantId),
          eq(checkSignatureUsers.userId, userId),
          eq(checkSignatures.isActive, true),
        ));
  return rows.map((s) => ({ id: s.id, label: s.label, maxAmount: s.maxAmount, width: s.width, height: s.height }));
}

export async function createSignature(
  tenantId: string,
  userId: string,
  input: { label: string; maxAmount?: string | null },
  file: SignatureImageUpload,
): Promise<CheckSignature> {
  const { mime, width, height } = validateSignatureImage(file);
  const existing = await db.query.checkSignatures.findFirst({
    where: and(eq(checkSignatures.tenantId, tenantId), eq(checkSignatures.label, input.label), eq(checkSignatures.isActive, true)),
  });
  if (existing) throw AppError.badRequest(`A signature named "${input.label}" already exists`, 'SIGNATURE_LABEL_TAKEN');

  const id = crypto.randomUUID();
  const filePath = storeImage(tenantId, id, file.buffer);
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const [row] = await db.insert(checkSignatures).values({
    id, tenantId, label: input.label, filePath, mimeType: mime, width, height, sha256,
    maxAmount: input.maxAmount ?? null, createdBy: userId,
  }).returning();
  await auditLog(tenantId, 'create', 'check_signature', id, null, { label: input.label, width, height, maxAmount: input.maxAmount ?? null }, userId);
  return publicShape(row!, []);
}

async function getOwned(tenantId: string, id: string): Promise<typeof checkSignatures.$inferSelect> {
  const sig = await db.query.checkSignatures.findFirst({
    where: and(eq(checkSignatures.tenantId, tenantId), eq(checkSignatures.id, id), eq(checkSignatures.isActive, true)),
  });
  if (!sig) throw AppError.notFound('Signature not found');
  return sig;
}

export async function updateSignature(
  tenantId: string,
  id: string,
  input: { label?: string; maxAmount?: string | null },
  userId: string,
): Promise<void> {
  const sig = await getOwned(tenantId, id);
  if (input.label !== undefined && input.label !== sig.label) {
    const clash = await db.query.checkSignatures.findFirst({
      where: and(eq(checkSignatures.tenantId, tenantId), eq(checkSignatures.label, input.label), eq(checkSignatures.isActive, true)),
    });
    if (clash) throw AppError.badRequest(`A signature named "${input.label}" already exists`, 'SIGNATURE_LABEL_TAKEN');
  }
  await db.update(checkSignatures).set({
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.maxAmount !== undefined ? { maxAmount: input.maxAmount } : {}),
    updatedAt: new Date(),
  }).where(eq(checkSignatures.id, id));
  await auditLog(tenantId, 'update', 'check_signature', id,
    { label: sig.label, maxAmount: sig.maxAmount },
    { label: input.label ?? sig.label, maxAmount: input.maxAmount !== undefined ? input.maxAmount : sig.maxAmount },
    userId);
}

export async function replaceImage(tenantId: string, id: string, file: SignatureImageUpload, userId: string): Promise<void> {
  const sig = await getOwned(tenantId, id);
  const { mime, width, height } = validateSignatureImage(file);
  const filePath = storeImage(tenantId, id, file.buffer);
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  await db.update(checkSignatures).set({ filePath, mimeType: mime, width, height, sha256, updatedAt: new Date() })
    .where(eq(checkSignatures.id, id));
  unlinkQuietly(sig.filePath);
  await auditLog(tenantId, 'update', 'check_signature', id,
    { width: sig.width, height: sig.height, sha256: sig.sha256 },
    { width, height, sha256 }, userId);
}

export async function setSignatureUsers(tenantId: string, id: string, userIds: string[], grantedBy: string): Promise<void> {
  const sig = await getOwned(tenantId, id);
  if (userIds.length > 0) {
    const tenantUsers = await authService.listTenantUsers(tenantId);
    const valid = new Set(tenantUsers.map((u: { id: string }) => u.id));
    const bad = userIds.filter((u) => !valid.has(u));
    if (bad.length > 0) throw AppError.badRequest('One or more users do not belong to this tenant');
  }
  const before = await db.query.checkSignatureUsers.findMany({ where: eq(checkSignatureUsers.signatureId, id) });
  await db.transaction(async (tx) => {
    await tx.delete(checkSignatureUsers).where(eq(checkSignatureUsers.signatureId, id));
    if (userIds.length > 0) {
      await tx.insert(checkSignatureUsers).values(userIds.map((userId) => ({ signatureId: id, tenantId, userId, grantedBy })));
    }
  });
  await auditLog(tenantId, 'update', 'check_signature_users', id,
    { label: sig.label, userIds: before.map((m) => m.userId) },
    { label: sig.label, userIds }, grantedBy);
}

export async function deleteSignature(tenantId: string, id: string, userId: string): Promise<void> {
  const sig = await getOwned(tenantId, id);
  await db.transaction(async (tx) => {
    await tx.update(checkSignatures).set({ isActive: false, updatedAt: new Date() }).where(eq(checkSignatures.id, id));
    await tx.delete(checkSignatureUsers).where(eq(checkSignatureUsers.signatureId, id));
  });
  unlinkQuietly(sig.filePath);
  await auditLog(tenantId, 'delete', 'check_signature', id, { label: sig.label }, null, userId);
}

export async function userCanUseSignature(tenantId: string, signatureId: string, userId: string, isOwner: boolean): Promise<boolean> {
  const sig = await db.query.checkSignatures.findFirst({
    where: and(eq(checkSignatures.tenantId, tenantId), eq(checkSignatures.id, signatureId), eq(checkSignatures.isActive, true)),
  });
  if (!sig) return false;
  if (isOwner) return true;
  const mapping = await db.query.checkSignatureUsers.findFirst({
    where: and(eq(checkSignatureUsers.signatureId, signatureId), eq(checkSignatureUsers.userId, userId)),
  });
  return !!mapping;
}

export interface LoadedSignature {
  id: string;
  label: string;
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
  maxAmount: string | null;
}

/** Decrypt the image into memory (only ever into memory). */
export async function loadSignatureImage(tenantId: string, signatureId: string): Promise<LoadedSignature> {
  const sig = await getOwned(tenantId, signatureId);
  const payload = fs.readFileSync(path.join(env.UPLOAD_DIR, sig.filePath), 'utf8');
  const bytes = decryptBuffer(payload);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== sig.sha256) {
    throw AppError.badRequest('Stored signature image failed its integrity check — re-upload it', 'SIGNATURE_CORRUPT');
  }
  return { id: sig.id, label: sig.label, bytes, mime: sig.mimeType, width: sig.width, height: sig.height, maxAmount: sig.maxAmount };
}

/** Cap check: amount == cap still signs; only strictly-over prints blank. */
export function signatureApplies(amount: string | number, maxAmount: string | null): boolean {
  if (maxAmount == null) return true;
  return Number(amount) <= Number(maxAmount);
}

// ─── Step-up re-authentication ──────────────────────────────────

/** Which credential this user must present for step-up. */
export async function stepUpMethodForUser(userId: string): Promise<StepUpMethod> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');
  return user.tfaTotpVerified ? 'totp' : 'password';
}

export async function verifySignerCredential(
  tenantId: string,
  userId: string,
  input: { password?: string; totpCode?: string },
): Promise<{ ok: boolean; method: StepUpMethod; reason?: string }> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  let ok = false;
  let method: StepUpMethod;
  let reason: string | undefined;

  if (user.tfaTotpVerified) {
    // 2FA-enrolled users must present the authenticator code — a password
    // alone must not unlock signing for an account that opted into TOTP.
    method = 'totp';
    if (!input.totpCode) {
      reason = 'Authenticator code required';
    } else {
      const result = await tfaService.verifyCode(userId, input.totpCode, 'totp');
      ok = result.valid;
      if (!ok) reason = result.lockedUntil ? 'Too many failed attempts — try again later' : 'Invalid authenticator code';
    }
  } else {
    method = 'password';
    if (!user.passwordHash) {
      // Passwordless (magic-link) account with no TOTP: nothing to verify.
      await bcrypt.compare(input.password ?? '', DUMMY_PASSWORD_HASH);
      throw AppError.badRequest(
        'Your account has no password and no authenticator app. Set a password or enroll an authenticator before printing with a signature.',
        'STEP_UP_UNAVAILABLE',
      );
    }
    if (!input.password) {
      reason = 'Password required';
    } else {
      ok = await bcrypt.compare(input.password, user.passwordHash);
      if (!ok) reason = 'Invalid password';
    }
  }

  await auditLog(tenantId, 'create', 'check_signature_stepup', userId, null, { success: ok, method }, userId);
  return { ok, method, reason };
}

export function issueStepUpToken(userId: string, tenantId: string): { stepUpToken: string; expiresAt: string } {
  const stepUpToken = jwt.sign({ userId, tenantId, checks_stepup: true }, stepUpSecret(), { expiresIn: STEP_UP_TTL_SECONDS });
  return { stepUpToken, expiresAt: new Date(Date.now() + STEP_UP_TTL_SECONDS * 1000).toISOString() };
}

export function verifyStepUpToken(token: string | undefined, userId: string, tenantId: string): boolean {
  if (!token) return false;
  try {
    const payload = jwt.verify(token, stepUpSecret(), { algorithms: ['HS256'] }) as { userId?: string; tenantId?: string; checks_stepup?: boolean };
    return payload.checks_stepup === true && payload.userId === userId && payload.tenantId === tenantId;
  } catch {
    return false;
  }
}
