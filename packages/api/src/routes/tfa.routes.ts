// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import * as tfaService from '../services/tfa.service.js';
import * as tfaEnrollment from '../services/tfa-enrollment.service.js';

export const tfaRouter = Router();
tfaRouter.use(authenticate);

// ─── User TFA Status ────────────────────────────────────────────

tfaRouter.get('/status', async (req, res) => {
  const status = await tfaEnrollment.getTfaStatus(req.userId);
  res.json(status);
});

// ─── Enable/Disable 2FA ─────────────────────────────────────────

tfaRouter.post('/enable', async (req, res) => {
  const recoveryCodes = await tfaEnrollment.enableTfa(req.userId);
  res.json({ enabled: true, recoveryCodes });
});

tfaRouter.post('/disable', async (req, res) => {
  await tfaEnrollment.disableTfa(req.userId, req.body.password);
  res.json({ disabled: true });
});

// ─── Methods ────────────────────────────────────────────────────

tfaRouter.post('/methods/email', async (req, res) => {
  await tfaEnrollment.addEmailMethod(req.userId);
  res.json({ method: 'email', added: true });
});

tfaRouter.delete('/methods/email', async (req, res) => {
  await tfaEnrollment.removeMethodFromUser(req.userId, 'email');
  res.json({ method: 'email', removed: true });
});

tfaRouter.post('/methods/sms', async (req, res) => {
  await tfaEnrollment.addSmsMethod(req.userId, req.body.phoneNumber);
  res.json({ message: 'Verification code sent' });
});

tfaRouter.post('/methods/sms/verify', async (req, res) => {
  const ok = await tfaEnrollment.verifySmsSetup(req.userId, req.body.code);
  if (!ok) { res.status(400).json({ error: { message: 'Invalid verification code' } }); return; }
  res.json({ method: 'sms', verified: true });
});

tfaRouter.delete('/methods/sms', async (req, res) => {
  await tfaEnrollment.removeMethodFromUser(req.userId, 'sms');
  res.json({ method: 'sms', removed: true });
});

tfaRouter.post('/methods/totp', async (req, res) => {
  const { secret, qrUri } = await tfaEnrollment.addTotpMethod(req.userId);
  res.json({ secret, qrUri });
});

tfaRouter.post('/methods/totp/verify', async (req, res) => {
  const ok = await tfaEnrollment.verifyTotpSetup(req.userId, req.body.code);
  if (!ok) { res.status(400).json({ error: { message: 'Invalid code. Make sure the time on your device is correct.' } }); return; }
  res.json({ method: 'totp', verified: true });
});

tfaRouter.delete('/methods/totp', async (req, res) => {
  await tfaEnrollment.removeMethodFromUser(req.userId, 'totp');
  res.json({ method: 'totp', removed: true });
});

// ─── Preferred Method ───────────────────────────────────────────

tfaRouter.put('/preferred-method', async (req, res) => {
  await tfaEnrollment.setPreferredMethod(req.userId, req.body.method);
  res.json({ preferredMethod: req.body.method });
});

// ─── Recovery Codes ─────────────────────────────────────────────

tfaRouter.post('/recovery-codes', async (req, res) => {
  const codes = await tfaEnrollment.regenerateRecoveryCodes(req.userId, req.body.password);
  res.json({ recoveryCodes: codes });
});

// ─── Trusted Devices ────────────────────────────────────────────

tfaRouter.get('/devices', async (req, res) => {
  const devices = await tfaService.listTrustedDevices(req.userId);
  res.json({ devices: devices.map((d) => ({
    id: d.id, deviceName: d.deviceName, ipAddress: d.ipAddress,
    trustedAt: d.trustedAt, lastUsedAt: d.lastUsedAt, expiresAt: d.expiresAt,
  }))});
});

tfaRouter.delete('/devices/:id', async (req, res) => {
  await tfaService.revokeDevice(req.userId, req.params['id']!);
  res.json({ revoked: true });
});

tfaRouter.delete('/devices', async (req, res) => {
  await tfaService.revokeAllDevices(req.userId);
  res.json({ revokedAll: true });
});
