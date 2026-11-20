// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Test scratch directories (.tmp-*, uploads written by attachment tests) are
// never committed (P33 review M1: two test PDFs had been).

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

function trackedFiles(): string[] | null {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0').filter((f) => f.length > 0);
  } catch {
    return null; // not a git checkout (a source archive): nothing to check
  }
}

describe('repository hygiene', () => {
  it('no test scratch directory (.tmp-*) is committed', () => {
    const files = trackedFiles();
    if (files === null) return;
    expect(files.filter((f) => f.split('/').some((seg) => seg.startsWith('.tmp-')))).toEqual([]);
  });
});
