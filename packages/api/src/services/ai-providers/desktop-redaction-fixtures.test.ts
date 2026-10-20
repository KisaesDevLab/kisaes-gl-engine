// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// E6 redaction fixtures: what the desktop strict backstop lets through to a
// cloud provider. Each fixture is sent as the user prompt of a (mocked)
// Anthropic call with NO caller-side sanitization, and the text the SDK
// receives is checked. Amounts, dates, merchants and invoice numbers must
// survive; bank, card, tax-id, contact and address data must not.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class AnthropicMock {
    messages = { create: mocks.create, stream: vi.fn() };
    models = { list: vi.fn() };
  },
}));

import { loadDesktopProfile, _resetDesktopProfileForTests } from '../../desktop/profile.js';
import * as secrets from '../../desktop/session-secrets.js';
import { getProvider } from './index.js';

interface Fixture { name: string; input: string; gone: string[]; kept: string[]; markers: string[] }

const FIXTURES: Fixture[] = [
  { name: 'routing and account numbers', input: 'ACH from routing 021000021 account 123456789012 for $1,234.56 on 2026-03-01',
    gone: ['021000021', '123456789012'], kept: ['$1,234.56', '2026-03-01', 'ACH'], markers: ['[ROUTING_REDACTED]', '[ACCT_REDACTED]'] },
  { name: 'account with keyword variants', input: 'Acct. 0012 3456 7890 at Chase; a/c 98765432 closed',
    gone: ['0012 3456 7890', '98765432'], kept: ['Chase'], markers: ['[ACCT_REDACTED]'] },
  { name: 'card numbers (Luhn-valid), last-4 preserved', input: 'VISA 4111 1111 1111 1111 and AMEX 3782-822463-10005; card ending in 4242',
    gone: ['4111 1111 1111 1111', '3782-822463-10005', 'ending in 4242'], kept: ['VISA', 'AMEX'], markers: ['[CARD_REDACTED]', '[CARD_ENDING_4242]'] },
  { name: 'tax ids', input: 'SSN 123-45-6789, EIN 12-3456789, invoice 1002 total 250.00',
    gone: ['123-45-6789', '12-3456789'], kept: ['invoice 1002', '250.00'], markers: ['[SSN_REDACTED]', '[EIN_REDACTED]'] },
  { name: 'email and phone', input: 'Contact jane.doe@example.com or (555) 123-4567 / 555-987-6543',
    gone: ['jane.doe@example.com', '(555) 123-4567', '555-987-6543'], kept: ['Contact'], markers: ['[EMAIL_REDACTED]', '[PHONE_REDACTED]'] },
  { name: 'mailing address (strict only)', input: 'Ship to 123 Main Street, Springfield, IL 62704 by Friday',
    gone: ['123 Main Street', '62704'], kept: ['by Friday'], markers: ['[ADDRESS_REDACTED]'] },
  { name: 'P2P personal names', input: 'ZELLE PAYMENT TO JANE DOE 45.00; VENMO CASHOUT; PAYPAL *NETFLIX 15.99',
    gone: ['JANE DOE'], kept: ['45.00', 'VENMO CASHOUT', 'PAYPAL *NETFLIX 15.99'], markers: ['[NAME]'] },
  { name: 'reference numbers and merchants survive', input: 'STARBUCKS #1234 ref 9876543210 trace 00112233445566 12/31/2025 $4.75',
    gone: [], kept: ['STARBUCKS #1234', 'ref 9876543210', '12/31/2025', '$4.75'], markers: [] },
];

beforeEach(() => {
  mocks.create.mockReset();
  mocks.create.mockResolvedValue({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: 'redact_' + 'r'.repeat(42), CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-redact-test'), CL_OFFLINE: 'off' });
  secrets.setAnthropicKey('sk-ant-api03-fixture-' + 'F'.repeat(40));
});

afterEach(() => {
  secrets.clearAllSessionSecrets();
  _resetDesktopProfileForTests();
});

async function sentText(input: string): Promise<string> {
  const p = getProvider('anthropic', {}, 'claude-x');
  await p.complete({ systemPrompt: 'system', userPrompt: input });
  const body = mocks.create.mock.calls.at(-1)![0] as { messages: Array<{ content: string }> };
  return body.messages[0]!.content;
}

describe('desktop strict backstop fixtures', () => {
  it.each(FIXTURES)('$name', async (f) => {
    const sent = await sentText(f.input);
    for (const g of f.gone) expect(sent, `should not send: ${g}`).not.toContain(g);
    for (const k of f.kept) expect(sent, `should keep: ${k}`).toContain(k);
    for (const m of f.markers) expect(sent, `should mark: ${m}`).toContain(m);
  });

  it('the reference-number fixture is sent unchanged (no false positives on amounts or ids)', async () => {
    const f = FIXTURES.at(-1)!;
    expect(await sentText(f.input)).toBe(f.input);
  });

  it('the backstop runs even when the caller asked for no sanitization at all', async () => {
    // Same provider instance a caller would get; the caller cannot opt out.
    const sent = await sentText('raw SSN 123-45-6789 goes out');
    expect(sent).toBe('raw SSN [SSN_REDACTED] goes out');
  });
});
