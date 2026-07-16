// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// NDJSON codec for the SYSTEM backup DB dump.
//
// The whole dump used to be one `JSON.stringify(contentObj)` string. Past V8's
// hard ~512 MiB string cap that throws `RangeError: Invalid string length`, so a
// firm with enough ledger/OCR data could produce NO backup at all — and the
// read side (`JSON.parse(buf.toString())`) hit the same wall on restore. This
// is a STRING-length limit, not heap, so more memory does not help.
//
// Fix: serialize the dump as newline-delimited JSON — ONE small JSON object per
// row. Each `JSON.stringify` is on a single row (bounded), the pieces are joined
// as bytes in a Buffer (Buffers have no 512 MiB limit), and the reader parses it
// LINE BY LINE straight out of the reassembled Buffer (slicing each line, never
// `.toString()` on the whole thing). Peak string size is bounded by the largest
// single row, independent of database size.
//
// JSON.stringify escapes newlines inside string values (`\n`), so a serialized
// row never contains a literal 0x0A byte — splitting on 0x0A is unambiguous.

const DUMP_MAGIC = 'ndjson-v1';

export interface SystemDumpContent {
  metadata?: unknown;
  installation_files?: unknown;
  tenants?: unknown[];
  users?: unknown[];
  user_tenant_access?: unknown[];
  global_tables?: Record<string, unknown[]>;
  tenant_data?: Record<string, Record<string, unknown[]>>;
}

/** Serialize a system dump to an NDJSON Buffer without ever building one giant
 *  string. Structure is reconstructed exactly by decodeSystemDump. */
export function encodeSystemDump(content: SystemDumpContent): Buffer {
  const chunks: Buffer[] = [];
  const push = (obj: unknown) => chunks.push(Buffer.from(JSON.stringify(obj) + '\n'));

  push({ vmdump: DUMP_MAGIC });
  push({ k: 'meta', v: content.metadata ?? {} });
  if (content.installation_files) push({ k: 'inst', v: content.installation_files });

  for (const row of content.tenants ?? []) push({ k: 'tenants', row });
  for (const row of content.users ?? []) push({ k: 'users', row });
  for (const row of content.user_tenant_access ?? []) push({ k: 'uta', row });
  // Emit a keyed marker even for EMPTY tables/tenants so the decoded object
  // preserves the same keys as the source (a table can be in the export plan
  // with zero rows — dropping the key would misrepresent the dump).
  for (const [t, rows] of Object.entries(content.global_tables ?? {})) {
    if (!rows || rows.length === 0) { push({ k: 'g', t }); continue; }
    for (const row of rows) push({ k: 'g', t, row });
  }
  for (const [id, tables] of Object.entries(content.tenant_data ?? {})) {
    const tableEntries = Object.entries(tables ?? {});
    if (tableEntries.length === 0) { push({ k: 'td', id }); continue; }
    for (const [t, rows] of tableEntries) {
      if (!rows || rows.length === 0) { push({ k: 'td', id, t }); continue; }
      for (const row of rows) push({ k: 'td', id, t, row });
    }
  }
  return Buffer.concat(chunks);
}

/** True if `buf` is an NDJSON system dump (peeks only the first line). */
export function isNdjsonDump(buf: Buffer): boolean {
  const nl = buf.indexOf(0x0a);
  const end = nl === -1 ? Math.min(buf.length, 128) : Math.min(nl, 128);
  return buf.toString('utf8', 0, end).includes('"vmdump"');
}

/** Reconstruct the system dump object from an NDJSON Buffer, parsing one line
 *  at a time so no intermediate string approaches the 512 MiB cap. */
export function decodeSystemDump(buf: Buffer): SystemDumpContent & Record<string, unknown> {
  const out: SystemDumpContent & Record<string, unknown> = {
    metadata: {},
    installation_files: null,
    tenants: [],
    users: [],
    user_tenant_access: [],
    global_tables: {},
    tenant_data: {},
  };

  const handle = (start: number, end: number) => {
    if (end <= start) return; // skip blank lines
    const obj = JSON.parse(buf.toString('utf8', start, end)) as Record<string, unknown>;
    if (obj['vmdump']) return; // header
    switch (obj['k']) {
      case 'meta': out.metadata = obj['v']; break;
      case 'inst': out.installation_files = obj['v']; break;
      case 'tenants': (out.tenants as unknown[]).push(obj['row']); break;
      case 'users': (out.users as unknown[]).push(obj['row']); break;
      case 'uta': (out.user_tenant_access as unknown[]).push(obj['row']); break;
      case 'g': {
        const t = obj['t'] as string;
        const arr = ((out.global_tables as Record<string, unknown[]>)[t] ??= []);
        if (obj['row'] !== undefined) arr.push(obj['row']); // empty-table marker has no row
        break;
      }
      case 'td': {
        const id = obj['id'] as string;
        const byTable = ((out.tenant_data as Record<string, Record<string, unknown[]>>)[id] ??= {});
        if (obj['t'] !== undefined) {
          const arr = (byTable[obj['t'] as string] ??= []);
          if (obj['row'] !== undefined) arr.push(obj['row']);
        }
        break;
      }
    }
  };

  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { handle(start, i); start = i + 1; }
  }
  if (start < buf.length) handle(start, buf.length);
  return out;
}
