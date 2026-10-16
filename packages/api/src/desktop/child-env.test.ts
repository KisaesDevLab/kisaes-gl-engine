// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childProcessEnv, minimalChildEnv } from './child-env.js';
import { loadDesktopProfile, _resetDesktopProfileForTests } from './profile.js';

afterEach(() => _resetDesktopProfileForTests());

const SOURCE: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  Path: 'C:\Windows',
  SystemRoot: 'C:\Windows',
  TEMP: '/tmp',
  LANG: 'C.UTF-8',
  LC_ALL: 'C',
  LD_LIBRARY_PATH: '/opt/poppler/lib',
  JWT_SECRET: 'jwt-secret-value',
  ENCRYPTION_KEY: 'enc-key-value',
  PLAID_ENCRYPTION_KEY: 'plaid-key-value',
  DATABASE_URL: 'postgres://u:pw@h/db',
  ANTHROPIC_API_KEY: 'sk-ant-xyz',
  SMTP_PASS: 'smtp-pass',
  NODE_OPTIONS: '--inspect',
};

describe('minimalChildEnv', () => {
  it('keeps only the run-time basics', () => {
    expect(minimalChildEnv(SOURCE)).toEqual({
      PATH: '/usr/bin',
      Path: 'C:\Windows',
      SystemRoot: 'C:\Windows',
      TEMP: '/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      LD_LIBRARY_PATH: '/opt/poppler/lib',
    });
  });
});

describe('childProcessEnv', () => {
  it('server: undefined (children inherit, unchanged)', () => {
    loadDesktopProfile({});
    expect(childProcessEnv()).toBeUndefined();
  });

  it('desktop: a real child sees no secrets', async () => {
    loadDesktopProfile({
      CL_MODE: 'desktop',
      CL_TOKEN: 'childenv_' + 'c'.repeat(40),
      CL_BIND: '127.0.0.1:0',
      CL_DATA_DIR: path.join(os.tmpdir(), 'cl-child-env-test'),
    });
    const saved = process.env['CL_TEST_CHILD_SECRET_KEY'];
    process.env['CL_TEST_CHILD_SECRET_KEY'] = 'must-not-leak-1234';
    try {
      const env = childProcessEnv();
      expect(env).toBeDefined();
      const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env });
      const seen = JSON.parse(stdout) as Record<string, string>;
      expect(Object.values(seen)).not.toContain('must-not-leak-1234');
      expect(Object.keys(seen).some((k) => /JWT_SECRET|ENCRYPTION_KEY|DATABASE_URL/i.test(k))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['CL_TEST_CHILD_SECRET_KEY'];
      else process.env['CL_TEST_CHILD_SECRET_KEY'] = saved;
    }
  });
});
