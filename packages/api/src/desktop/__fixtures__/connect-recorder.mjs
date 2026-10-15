// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Test preload for desktop/offline-matrix.test.ts (node --import). Records
// every TCP connect and DNS lookup that reaches the real implementation,
// one JSON line per call, to the file named by CL_TEST_CONNECT_LOG. It is
// loaded before bootstrap.ts, so the egress guard wraps it: blocked
// attempts never reach it (the guard logs those itself).

import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';

const out = process.env['CL_TEST_CONNECT_LOG'];
if (out) {
  const record = (entry) => {
    try {
      fs.appendFileSync(out, `${JSON.stringify(entry)}\n`);
    } catch {
      // best effort
    }
  };
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function recordConnect(...args) {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    if (first && typeof first === 'object') {
      if (typeof first.path === 'string' && first.path) record({ kind: 'ipc' });
      else record({ kind: 'tcp', host: first.host ?? 'localhost', port: first.port ?? null });
    } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
      record({ kind: 'ipc' });
    } else {
      record({ kind: 'tcp', host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first ?? null });
    }
    return origConnect.apply(this, args);
  };
  const origLookup = dns.lookup;
  dns.lookup = function recordLookup(...args) {
    record({ kind: 'dns', host: args[0] });
    return origLookup.apply(this, args);
  };
}
