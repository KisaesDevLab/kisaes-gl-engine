// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {
  loadDesktopProfile,
  parseBind,
  verifyDesktopToken,
  redisEnabled,
  isDesktop,
  DesktopConfigError,
  _resetDesktopProfileForTests,
} from './profile.js';
import { parseEnv } from '../config/env.js';

const TOKEN = 'A'.repeat(20) + 'b_c-d' + '0123456789abcdefghij'; // 45 base64url chars
const DATA_DIR = path.join(os.tmpdir(), 'cl-profile-test');

function desktopEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    CL_MODE: 'desktop',
    CL_TOKEN: TOKEN,
    CL_BIND: '127.0.0.1:0',
    CL_DATA_DIR: DATA_DIR,
    DATABASE_URL: 'postgresql://cl@127.0.0.1:5432/books',
    JWT_SECRET: '0123456789abcdef0123456789abcdef',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    PLAID_ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
    ...extra,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DesktopConfigError) return err.code;
    throw err;
  }
  return 'NO_ERROR';
}

afterEach(() => {
  _resetDesktopProfileForTests();
});

describe('server mode (CL_MODE unset)', () => {
  it('does not mutate the environment at all', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgresql://u:p@db/books',
      REDIS_URL: 'redis://redis:6379',
      CL_TOKEN: 'left-alone',
      PORT: '3001',
    };
    const before = JSON.stringify(env);
    const p = loadDesktopProfile(env);
    expect(JSON.stringify(env)).toBe(before);
    expect(p.mode).toBe('server');
    expect(p.queueBackend).toBe('bullmq');
    expect(p.bind).toBeNull();
  });

  it('CL_MODE=server is the same as unset', () => {
    expect(loadDesktopProfile({ CL_MODE: 'server' }).mode).toBe('server');
  });

  it('keeps Redis enabled with the default backend', () => {
    loadDesktopProfile({ REDIS_URL: 'redis://redis:6379' });
    expect(isDesktop()).toBe(false);
    expect(redisEnabled()).toBe(true);
  });

  it('no token is accepted in server mode', () => {
    loadDesktopProfile({});
    expect(verifyDesktopToken(TOKEN)).toBe(false);
  });

  it('rejects an unknown CL_MODE', () => {
    expect(codeOf(() => loadDesktopProfile({ CL_MODE: 'laptop' }))).toBe('CL_MODE_INVALID');
  });
});

describe('desktop mode', () => {
  it('fills directory defaults under CL_DATA_DIR and forces Redis-free switches', () => {
    const env = desktopEnv({ HIBP_DISABLED: '0', EXPECT_WORKER: 'true', SHARE_ENABLED: 'true' });
    const p = loadDesktopProfile(env);
    const root = path.resolve(DATA_DIR);
    expect(p.mode).toBe('desktop');
    expect(p.dataDir).toBe(root);
    expect(env['DATA_DIR']).toBe(root);
    expect(env['UPLOAD_DIR']).toBe(path.join(root, 'uploads'));
    expect(env['BACKUP_DIR']).toBe(path.join(root, 'backups'));
    expect(env['CONFIG_DIR']).toBe(path.join(root, 'config'));
    expect(env['STORAGE_CACHE_DIR']).toBe(path.join(root, 'cache'));
    expect(env['CL_ARCHIVE_DIR']).toBe(path.join(root, 'archives'));
    expect(env['HIBP_DISABLED']).toBe('1');
    expect(env['EXPECT_WORKER']).toBe('false');
    expect(env['SHARE_ENABLED']).toBe('false');
    expect(env['QUEUE_BACKEND']).toBe('none');
    expect(env['PORT']).toBe('0');
    expect(p.queueBackend).toBe('none');
    expect(redisEnabled()).toBe(false);
  });

  it('keeps explicitly set directories', () => {
    const env = desktopEnv({ UPLOAD_DIR: '/elsewhere/uploads' });
    loadDesktopProfile(env);
    expect(env['UPLOAD_DIR']).toBe('/elsewhere/uploads');
  });

  it('the resulting environment passes env.ts without REDIS_URL', () => {
    const env = desktopEnv();
    loadDesktopProfile(env);
    const r = parseEnv(env);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.REDIS_URL).toBeUndefined();
      expect(r.data.QUEUE_BACKEND).toBe('none');
      expect(r.data.EXPECT_WORKER).toBe(false);
      expect(r.data.SHARE_ENABLED).toBe(false);
      expect(r.data.HIBP_DISABLED).toBe('1');
    }
  });

  it('removes CL_TOKEN from the environment and verifies it in constant time', () => {
    const env = desktopEnv();
    loadDesktopProfile(env);
    expect('CL_TOKEN' in env).toBe(false);
    expect(verifyDesktopToken(TOKEN)).toBe(true);
    expect(verifyDesktopToken(TOKEN + 'x')).toBe(false); // different length
    expect(verifyDesktopToken(TOKEN.slice(0, -1) + 'Z')).toBe(false); // same length, wrong
    expect(verifyDesktopToken(undefined)).toBe(false);
    expect(verifyDesktopToken('')).toBe(false);
    expect(verifyDesktopToken([TOKEN, TOKEN])).toBe(false);
  });

  it('a child process started after load does not inherit CL_TOKEN', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, desktopEnv());
      loadDesktopProfile(process.env);
      expect(process.env['CL_TOKEN']).toBeUndefined();
      const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.CL_TOKEN))'], {
        encoding: 'utf8',
      });
      expect(out).toBe('undefined');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('token: required, at least 256 bits of base64url/hex', () => {
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_TOKEN: undefined })))).toBe('CL_TOKEN_REQUIRED');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_TOKEN: 'short' })))).toBe('CL_TOKEN_INVALID');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_TOKEN: 'x'.repeat(42) })))).toBe('CL_TOKEN_INVALID');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_TOKEN: 'a b'.repeat(20) })))).toBe('CL_TOKEN_INVALID');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_TOKEN: 'f'.repeat(64) })))).toBe('NO_ERROR');
  });

  it('even an invalid token is removed from the environment', () => {
    const env = desktopEnv({ CL_TOKEN: 'short' });
    codeOf(() => loadDesktopProfile(env));
    expect('CL_TOKEN' in env).toBe(false);
  });

  it('bind: required, loopback only', () => {
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_BIND: undefined })))).toBe('CL_BIND_REQUIRED');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_BIND: 'localhost:3001' })))).toBe('CL_BIND_INVALID');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_BIND: '0.0.0.0:0' })))).toBe('CL_BIND_NOT_LOOPBACK');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_BIND: '192.168.1.5:3001' })))).toBe('CL_BIND_NOT_LOOPBACK');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_BIND: '[::]:0' })))).toBe('CL_BIND_NOT_LOOPBACK');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_BIND: '[::1]:4000' })))).toBe('NO_ERROR');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_BIND: '127.0.0.2:4000' })))).toBe('NO_ERROR');
  });

  it('CL_LAN=1 is refused (no TLS yet), whatever the address', () => {
    for (const bind of ['0.0.0.0:0', '[::]:0', '8.8.8.8:3001', '192.168.1.5:3001', '[fd00::1]:0', '127.0.0.1:0']) {
      expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_BIND: bind, CL_LAN: '1' }))), bind).toBe('CL_LAN_UNSUPPORTED');
    }
    // Any other value is not LAN mode: loopback rules apply.
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_BIND: '0.0.0.0:0', CL_LAN: '0' })))).toBe('CL_BIND_NOT_LOOPBACK');
    expect(loadDesktopProfile(desktopEnv({ CL_LAN: '0' })).lan).toBe(false);
  });

  it('parseBind handles v4, v6, port range', () => {
    expect(parseBind('127.0.0.1:0')).toEqual({ host: '127.0.0.1', port: 0 });
    expect(parseBind('[::1]:65535')).toEqual({ host: '::1', port: 65535 });
    expect(() => parseBind('127.0.0.1:65536')).toThrow(DesktopConfigError);
    expect(() => parseBind('300.0.0.1:1')).toThrow(DesktopConfigError);
    expect(() => parseBind('127.0.0.1')).toThrow(DesktopConfigError);
  });

  it('data dir is required', () => {
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_DATA_DIR: undefined })))).toBe('CL_DATA_DIR_REQUIRED');
  });

  it('rejects server-only switches that need Redis or the AI router', () => {
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ RATE_LIMIT_REDIS: '1' })))).toBe('CL_ENV_CONFLICT');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ VIBE_AI_MODE: 'router' })))).toBe('CL_ENV_CONFLICT');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ QUEUE_BACKEND: 'bullmq' })))).toBe('CL_ENV_CONFLICT');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ QUEUE_BACKEND: 'kafka' })))).toBe('QUEUE_BACKEND_INVALID');
  });

  it('validates CL_OFFLINE and log settings', () => {
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_OFFLINE: 'maybe' })))).toBe('CL_ENV_INVALID');
    expect(codeOf(() => loadDesktopProfile(desktopEnv({ CL_LOG_MAX_BYTES: '-1' })))).toBe('CL_ENV_INVALID');
    const p = loadDesktopProfile(desktopEnv({ CL_OFFLINE: 'on', CL_LOG_FILE: 'engine.log', CL_LOG_KEEP: '3' }));
    expect(p.offline).toBe('on');
    expect(p.logFile).toBe(path.resolve('engine.log'));
    expect(p.logKeep).toBe(3);
    expect(p.logMaxBytes).toBe(10 * 1024 * 1024);
  });

  it('CL_REQUIRE_NON_SUPERUSER is off unless set to 1', () => {
    expect(loadDesktopProfile(desktopEnv()).requireNonSuperuser).toBe(false);
    expect(loadDesktopProfile(desktopEnv({ CL_REQUIRE_NON_SUPERUSER: '1' })).requireNonSuperuser).toBe(true);
  });
});
