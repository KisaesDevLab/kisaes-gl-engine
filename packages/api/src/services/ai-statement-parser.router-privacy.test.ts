// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Statement text sent through the Vibe AI Router is scrubbed unless the admin
// attested the router keeps statements on this server. Not routed, the
// configured provider decides as before (local → no scrub).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { statementPiiMode } from './ai-statement-parser.service.js';

const KEYS = ['VIBE_AI_MODE', 'VIBE_AI_ROUTER_URL', 'VIBE_AI_TOKEN'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env['VIBE_AI_MODE'] = 'direct';
  process.env['VIBE_AI_ROUTER_URL'] = 'http://router.test:8220';
  process.env['VIBE_AI_TOKEN'] = 'tok';
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const local = { openaiCompatBaseUrl: 'http://192.168.1.110:8082/v1' };

describe('statementPiiMode', () => {
  it('keeps the local provider\'s full-fidelity text when statements stay direct', () => {
    expect(statementPiiMode('ollama', { ...local, routerEnabled: true, routerFeatures: {} })).toBe('none');
  });

  it('scrubs strictly when statements go through the router', () => {
    expect(statementPiiMode('ollama', {
      ...local, routerEnabled: true, routerFeatures: { mybooks_statement_extract: 'router' },
    })).toBe('strict');
  });

  it('skips scrubbing only when the admin attests the router keeps statements on-box', () => {
    expect(statementPiiMode('ollama', {
      ...local, routerEnabled: true, routerFeatures: { mybooks_statement_extract: 'router' }, routerStatementsOnBox: true,
    })).toBe('none');
  });

  it('legacy env router mode leaves statements direct by default', () => {
    process.env['VIBE_AI_MODE'] = 'router';
    expect(statementPiiMode('ollama', { ...local, routerEnabled: null })).toBe('none');
  });
});
