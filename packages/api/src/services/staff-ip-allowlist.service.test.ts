// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { staffIpAllowlist } from '../db/schema/index.js';
import {
  addEntry,
  listEntries,
  removeEntry,
  isIpAllowed,
  isValidCidr,
  invalidateCache,
  normaliseRequestIp,
  __internal,
} from './staff-ip-allowlist.service.js';

async function wipe() {
  await db.delete(staffIpAllowlist);
  invalidateCache();
}

describe('staff-ip-allowlist CIDR parser', () => {
  it('parses valid IPv4 ranges', () => {
    expect(__internal.parseCidr('10.0.0.0/8')).toMatchObject({ family: 4, prefix: 8 });
    expect(__internal.parseCidr('192.168.1.1/32')).toMatchObject({ family: 4, prefix: 32 });
    expect(__internal.parseCidr('203.0.113.5')).toMatchObject({ family: 4, prefix: 32 });
  });

  it('parses valid IPv6 ranges', () => {
    expect(__internal.parseCidr('2001:db8::/32')).toMatchObject({ family: 6, prefix: 32 });
    expect(__internal.parseCidr('fe80::1')).toMatchObject({ family: 6, prefix: 128 });
  });

  it('rejects malformed input', () => {
    expect(__internal.parseCidr('not-an-ip')).toBeNull();
    expect(__internal.parseCidr('10.0.0.0/33')).toBeNull();
    expect(__internal.parseCidr('10.0.0.0/-1')).toBeNull();
    expect(__internal.parseCidr('10.0.0.0/')).toBeNull();
    expect(__internal.parseCidr('')).toBeNull();
  });

  it('CIDR containment honours the prefix', () => {
    const net = __internal.parseCidr('10.0.0.0/8')!;
    expect(__internal.cidrContains(net, '10.5.6.7')).toBe(true);
    expect(__internal.cidrContains(net, '11.0.0.1')).toBe(false);

    const host = __internal.parseCidr('203.0.113.5/32')!;
    expect(__internal.cidrContains(host, '203.0.113.5')).toBe(true);
    expect(__internal.cidrContains(host, '203.0.113.6')).toBe(false);

    const v6 = __internal.parseCidr('2001:db8::/32')!;
    expect(__internal.cidrContains(v6, '2001:db8:0:1::1')).toBe(true);
    expect(__internal.cidrContains(v6, '2001:db9::1')).toBe(false);
  });
});

describe('normaliseRequestIp', () => {
  it('strips IPv4-mapped IPv6 prefix', () => {
    expect(normaliseRequestIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
  });

  it('strips IPv6 zone identifier', () => {
    expect(normaliseRequestIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('returns null for missing input', () => {
    expect(normaliseRequestIp(undefined)).toBeNull();
    expect(normaliseRequestIp('')).toBeNull();
  });
});

describe('isValidCidr', () => {
  it('accepts host entries without a prefix', () => {
    expect(isValidCidr('192.168.1.1')).toBe(true);
  });
  it('rejects garbage', () => {
    expect(isValidCidr('not-a-cidr')).toBe(false);
  });
});

describe('staff-ip-allowlist CRUD + membership', () => {
  beforeEach(async () => { await wipe(); });
  afterEach(async () => { await wipe(); });

  it('empty allowlist allows everything (cold-start safety)', async () => {
    expect(await isIpAllowed('203.0.113.5')).toBe(true);
  });

  it('persists an entry and rejects duplicates', async () => {
    const a = await addEntry({ cidr: '203.0.113.0/24', description: 'office' });
    expect(a.cidr).toBe('203.0.113.0/24');

    await expect(addEntry({ cidr: '203.0.113.0/24' })).rejects.toThrow(/already/i);
    const rows = await listEntries();
    expect(rows).toHaveLength(1);
  });

  it('rejects invalid CIDR input', async () => {
    await expect(addEntry({ cidr: 'not-a-cidr' })).rejects.toThrow(/valid/i);
  });

  it('allows a request IP inside an entry and denies outside', async () => {
    await addEntry({ cidr: '203.0.113.0/24' });
    invalidateCache(); // drop cold-start no-entries cache
    expect(await isIpAllowed('203.0.113.99')).toBe(true);
    expect(await isIpAllowed('198.51.100.1')).toBe(false);
  });

  it('honours IPv4-mapped IPv6 request IPs', async () => {
    await addEntry({ cidr: '203.0.113.0/24' });
    invalidateCache();
    expect(await isIpAllowed('::ffff:203.0.113.99')).toBe(true);
  });

  it('removeEntry drops the row', async () => {
    const e = await addEntry({ cidr: '10.0.0.0/8' });
    await removeEntry(e.id);
    const rows = await listEntries();
    expect(rows).toHaveLength(0);
  });
});
