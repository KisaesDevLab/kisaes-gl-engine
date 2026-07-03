// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// HTTP adapter for the Tax1099.com (Zenwork) e-filing API.
//
// EVERY provider-specific detail lives in THIS file so it can be
// adjusted in one place when the firm's Tax1099 developer credentials
// and gated API documentation arrive. What is publicly documented and
// relied on here (see tax1099.com/api-license-agreement):
//   - each integrated application is assigned a unique API Key
//   - a session is initiated by passing that Key together with the
//     username + password of a valid Tax1099 account
//   - the API is JSON REST; form submissions carry payer + recipient
//     + form data and return a submission reference
// Endpoint paths below follow the provider's published v2 shape and
// are constants — adjust here if the gated docs differ.

import { AppError } from '../utils/errors.js';

export interface Tax1099Credentials {
  apiKey: string;
  username: string;
  password: string;
  environment: 'sandbox' | 'production';
  baseUrlOverride?: string | null;
}

export interface Tax1099Payer {
  businessName: string;
  ein: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  phone?: string;
  email?: string;
}

export interface Tax1099Recipient {
  name: string;
  tin: string;
  tinType: 'SSN' | 'EIN' | '';
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
  email?: string;
  // box code → amount, e.g. { '1': 1234.56 } for NEC box 1
  boxes: Record<string, number>;
  backupWithholding?: boolean;
}

export interface Tax1099SubmitInput {
  taxYear: number;
  formType: string; // '1099-NEC' | '1099-MISC'
  payer: Tax1099Payer;
  recipients: Tax1099Recipient[];
}

const DEFAULT_BASE_URLS: Record<'sandbox' | 'production', string> = {
  sandbox: 'https://testapi.tax1099.com',
  production: 'https://api.tax1099.com',
};

// Provider endpoint paths — single source of truth for this adapter.
const PATHS = {
  session: '/api/v2/session',
  submit: '/api/v2/forms/submit',
  status: (ref: string) => `/api/v2/forms/status/${encodeURIComponent(ref)}`,
};

const TIMEOUT_MS = 30_000;

function baseUrl(creds: Tax1099Credentials): string {
  return (creds.baseUrlOverride || DEFAULT_BASE_URLS[creds.environment]).replace(/\/+$/, '');
}

async function httpJson(url: string, init: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw AppError.badRequest(
      `Tax1099 API unreachable (${url}): ${err instanceof Error ? err.message : 'network error'}`,
      'TAX1099_UNREACHABLE',
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text?.slice(0, 500) }; }
  if (!res.ok) {
    const msg = body?.message || body?.error || body?.raw || `HTTP ${res.status}`;
    throw AppError.badRequest(`Tax1099 API error: ${msg}`, 'TAX1099_API_ERROR');
  }
  return body;
}

export interface Tax1099Session { token: string; baseUrl: string }

/** Initiate a session: API Key + account username/password → token. */
export async function createSession(creds: Tax1099Credentials): Promise<Tax1099Session> {
  const base = baseUrl(creds);
  const body = await httpJson(`${base}${PATHS.session}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: creds.apiKey, userName: creds.username, password: creds.password }),
  });
  const token = body?.token ?? body?.sessionToken ?? body?.access_token;
  if (!token) {
    throw AppError.badRequest('Tax1099 session response did not include a token', 'TAX1099_NO_TOKEN');
  }
  return { token: String(token), baseUrl: base };
}

/** Submit a batch of forms; returns the provider's submission reference. */
export async function submitForms(
  session: Tax1099Session,
  input: Tax1099SubmitInput,
): Promise<{ referenceId: string; raw: unknown }> {
  const body = await httpJson(`${session.baseUrl}${PATHS.submit}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      taxYear: input.taxYear,
      formType: input.formType,
      payer: input.payer,
      recipients: input.recipients,
    }),
  });
  const ref = body?.referenceId ?? body?.submissionId ?? body?.id;
  if (!ref) {
    throw AppError.badRequest('Tax1099 submit response did not include a submission reference', 'TAX1099_NO_REFERENCE');
  }
  return { referenceId: String(ref), raw: body };
}

/** Fetch the current status of a prior submission. */
export async function checkStatus(
  session: Tax1099Session,
  referenceId: string,
): Promise<{ status: string; message: string | null; raw: unknown }> {
  const body = await httpJson(`${session.baseUrl}${PATHS.status(referenceId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const status = String(body?.status ?? 'unknown').toLowerCase();
  const message = body?.message ? String(body.message) : null;
  return { status, message, raw: body };
}
