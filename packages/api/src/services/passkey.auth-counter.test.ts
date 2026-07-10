// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression: verifyAuthentication wrote the new WebAuthn signature counter
// unconditionally and never rejected a NON-ADVANCING counter, so a cloned
// authenticator (which replays a counter <= the stored value) could log in.
// The fix fails closed on a non-advancing counter, while still allowing the
// legitimate 0/0 "authenticator has no counter" case.

const CHALLENGE = 'testchallengeAAAA_-';

const mocks = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(async () => ({ challenge: CHALLENGE })),
  verifyAuthenticationResponse: vi.fn(),
  findFirstPasskey: vi.fn(),
  findFirstUser: vi.fn(async () => null), // proceeding past the counter check 404s here
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
  // Unused by these tests but imported by the module.
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      passkeys: { findFirst: () => mocks.findFirstPasskey() },
      users: { findFirst: () => mocks.findFirstUser() },
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

import { getAuthenticationOptions, verifyAuthentication } from './passkey.service.js';

function clientResponse() {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge: CHALLENGE, origin: 'http://localhost:5173' }),
  ).toString('base64url');
  return { id: 'cred1', rawId: 'cred1', type: 'public-key', response: { clientDataJSON } } as never;
}

async function seedChallenge() {
  // Stores CHALLENGE in the module's in-memory challenge map (no DB; no email).
  await getAuthenticationOptions();
}

function passkeyRow(counter: number) {
  return {
    id: 'pk1',
    credentialId: 'cred1',
    publicKey: Buffer.from('pub').toString('base64url'),
    counter,
    transports: '',
    userId: 'u1',
  };
}

describe('passkey verifyAuthentication — clone detection via signature counter', () => {
  beforeEach(() => {
    mocks.verifyAuthenticationResponse.mockReset();
    mocks.findFirstPasskey.mockReset();
    mocks.findFirstUser.mockReset().mockResolvedValue(null);
  });

  it('rejects a REGRESSED counter (clone replay): stored 10, presented 5', async () => {
    mocks.findFirstPasskey.mockResolvedValue(passkeyRow(10));
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    });
    await seedChallenge();
    await expect(verifyAuthentication(clientResponse())).rejects.toThrow(/Passkey verification failed/);
  });

  it('rejects an EQUAL counter (no advance): stored 10, presented 10', async () => {
    mocks.findFirstPasskey.mockResolvedValue(passkeyRow(10));
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 10 },
    });
    await seedChallenge();
    await expect(verifyAuthentication(clientResponse())).rejects.toThrow(/Passkey verification failed/);
  });

  it('ALLOWS a no-counter authenticator (0/0) past the clone check', async () => {
    mocks.findFirstPasskey.mockResolvedValue(passkeyRow(0));
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    });
    await seedChallenge();
    // Passes the counter gate, then 404s at the user lookup (findFirstUser → null).
    // The DIFFERENT error proves the 0/0 case was not blocked as a clone.
    await expect(verifyAuthentication(clientResponse())).rejects.toThrow(/User not found/);
  });

  it('ALLOWS an advancing counter past the clone check: stored 10, presented 11', async () => {
    mocks.findFirstPasskey.mockResolvedValue(passkeyRow(10));
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 11 },
    });
    await seedChallenge();
    await expect(verifyAuthentication(clientResponse())).rejects.toThrow(/User not found/);
  });
});
