// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Regression guard for MCP tool authorization.
//
// Every registered tool must enforce a scope. We do this by reading the
// server.ts source and asserting that for each `registerTool(` call, the
// body of the handler either:
//   (a) calls `checkScope(auth, ...)` somewhere, or
//   (b) is explicitly allow-listed below as scope-agnostic.
//
// A future tool that forgets both fails this test loudly at CI time, so
// "missing authorization check" can't slip past review silently. That's the
// whole point — the M10 audit finding wasn't about an existing hole, it
// was about drift risk. This catches the drift.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf-8');

// Tools that legitimately need no scope (they only expose or switch a
// user's own context and can't cause any side effect the bearer isn't
// already authorized to perform).
const SCOPE_EXEMPT = new Set([
  'list_companies',
  'set_active_company',
  'get_active_company',
]);

interface ToolBlock {
  name: string;
  body: string;
}

function extractToolBlocks(src: string): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  // Walk the source by finding each registerTool(' literal opener, then
  // scanning forward with a brace/paren depth counter to find the matching
  // close of the registerTool call. This is more robust than a regex for
  // nested parens inside the handler body.
  const opener = /registerTool\(\s*'([^']+)'/g;
  for (let m = opener.exec(src); m; m = opener.exec(src)) {
    const name = m[1]!;
    const start = m.index + m[0].length;
    let i = start;
    let depthParen = 1;
    let inStr: string | null = null;
    let inTpl = false;
    while (i < src.length) {
      const ch = src[i]!;
      const prev = src[i - 1];
      if (inStr) {
        if (ch === inStr && prev !== '\\') inStr = null;
      } else if (inTpl) {
        if (ch === '`' && prev !== '\\') inTpl = false;
      } else if (ch === '"' || ch === "'") {
        inStr = ch;
      } else if (ch === '`') {
        inTpl = true;
      } else if (ch === '(') {
        depthParen++;
      } else if (ch === ')') {
        depthParen--;
        if (depthParen === 0) {
          blocks.push({ name, body: src.slice(start, i) });
          break;
        }
      }
      i++;
    }
  }
  return blocks;
}

describe('MCP tool scope enforcement', () => {
  const blocks = extractToolBlocks(SERVER_SRC);

  it('parses every registered tool', () => {
    // Sanity: if the parser misses blocks the whole test is meaningless.
    // Keep this in sync with the tool count — it should only ever grow.
    expect(blocks.length).toBeGreaterThanOrEqual(79);
  });

  it('every tool either calls checkScope or is explicitly scope-exempt', () => {
    const offenders: string[] = [];
    for (const { name, body } of blocks) {
      if (SCOPE_EXEMPT.has(name)) continue;
      if (!/\bcheckScope\s*\(\s*auth\s*,/.test(body)) {
        offenders.push(name);
      }
    }
    expect(offenders, `Tools missing checkScope: ${offenders.join(', ')}`).toEqual([]);
  });
});
