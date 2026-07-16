// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { encodeSystemDump, decodeSystemDump, isNdjsonDump } from './system-dump-codec.js';

describe('system-dump-codec', () => {
  const sample = {
    metadata: { backup_type: 'system', format: 'kis-books-system-v2', tenantCount: 2 },
    installation_files: { sentinel: 'c2VudA==', hostId: 'host-1' },
    // Embedded newlines/quotes prove NDJSON line-splitting is safe: JSON.stringify
    // escapes them, so a serialized row never contains a literal 0x0A byte.
    tenants: [{ id: 't1', name: 'Line one\nLine two' }, { id: 't2', name: 'Quote " and \\ back' }],
    users: [{ id: 'u1', email: 'a@b.com' }],
    user_tenant_access: [{ userId: 'u1', tenantId: 't1' }],
    global_tables: {
      coa_templates: [{ id: 'c1', slug: 'retail', accounts: [{ code: '1000' }] }],
      plaid_config: [{ id: 'p1', environment: 'sandbox' }],
    },
    tenant_data: {
      t1: {
        transactions: [{ id: 'tx1', memo: 'multi\nline\nmemo' }, { id: 'tx2', memo: null }],
        journal_lines: [{ id: 'jl1', debit: '100.0000' }],
      },
      t2: { budgets: [{ id: 'b1', amounts: { jan: 5 } }] },
    },
  };

  it('round-trips a representative system dump exactly', () => {
    const buf = encodeSystemDump(sample);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(isNdjsonDump(buf)).toBe(true);

    const decoded = decodeSystemDump(buf);
    expect(decoded.metadata).toEqual(sample.metadata);
    expect(decoded.installation_files).toEqual(sample.installation_files);
    expect(decoded.tenants).toEqual(sample.tenants);
    expect(decoded.users).toEqual(sample.users);
    expect(decoded.user_tenant_access).toEqual(sample.user_tenant_access);
    expect(decoded.global_tables).toEqual(sample.global_tables);
    expect(decoded.tenant_data).toEqual(sample.tenant_data);
  });

  it('preserves embedded newlines in row values (no line-split corruption)', () => {
    const decoded = decodeSystemDump(encodeSystemDump(sample));
    expect((decoded.tenant_data as any).t1.transactions[0].memo).toBe('multi\nline\nmemo');
    expect((decoded.tenants as any)[0].name).toBe('Line one\nLine two');
  });

  it('handles empty / missing sections', () => {
    const buf = encodeSystemDump({ metadata: { format: 'x' } });
    const decoded = decodeSystemDump(buf);
    expect(decoded.metadata).toEqual({ format: 'x' });
    expect(decoded.tenants).toEqual([]);
    expect(decoded.users).toEqual([]);
    expect(decoded.global_tables).toEqual({});
    expect(decoded.tenant_data).toEqual({});
    expect(decoded.installation_files).toBeNull();
  });

  it('isNdjsonDump distinguishes an NDJSON dump from a plain JSON blob', () => {
    expect(isNdjsonDump(encodeSystemDump(sample))).toBe(true);
    expect(isNdjsonDump(Buffer.from(JSON.stringify(sample)))).toBe(false);
    expect(isNdjsonDump(Buffer.from('{"metadata":{}}'))).toBe(false);
  });

  it('scales row-by-row: 60k rows round-trip correctly (the line-parse path)', () => {
    const transactions = Array.from({ length: 60_000 }, (_, i) => ({
      id: `tx-${i}`, memo: `payment ${i}\nwith newline`, total: `${i}.00`,
    }));
    const big = {
      metadata: { format: 'kis-books-system-v2' },
      tenant_data: { tA: { transactions } },
    };
    const buf = encodeSystemDump(big);
    const decoded = decodeSystemDump(buf);
    const out = (decoded.tenant_data as any).tA.transactions;
    expect(out).toHaveLength(60_000);
    expect(out[0].id).toBe('tx-0');
    expect(out[59_999].memo).toBe('payment 59999\nwith newline');
  });
});
