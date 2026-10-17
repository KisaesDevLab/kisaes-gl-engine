// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Test preload for desktop/offline-matrix.test.ts (node --import). Records
// every TCP connect and DNS lookup that reaches the real implementation,
// one JSON line per call, to the file named by CL_TEST_CONNECT_LOG — in the
// main thread AND in every worker thread (each worker gets the same
// recorder as a prelude). It is loaded before bootstrap.ts, so the egress
// guard wraps it: blocked attempts never reach it (the guard logs those).
//
// With CL_TEST_WORKER_PROBE=1 it also starts one worker thread 3 s after
// load that tries to connect to 192.0.2.1:9 (TEST-NET-1, never routed) and
// records the outcome as {kind:'worker-probe', code}.

import fs from 'node:fs';
import { Worker } from 'node:worker_threads';

const out = process.env['CL_TEST_CONNECT_LOG'];

// Runs in the main thread and, as source text, at the start of every worker.
function installRecorder(file, where) {
  const fs = require('node:fs');
  const net = require('node:net');
  const dns = require('node:dns');
  const record = (entry) => {
    try {
      fs.appendFileSync(file, `${JSON.stringify({ ...entry, thread: where })}\n`);
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
    } else if (typeof first === 'string' && !(Number(first) >= 0)) {
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
  record({ kind: 'thread-start' });
}

if (out) {
  const { createRequire } = await import('node:module');
  globalThis.require ??= createRequire(import.meta.url);
  installRecorder(out, 'main');

  // Every worker starts with the recorder. The egress guard, installed
  // later, subclasses this Worker, so in a worker the order is recorder,
  // then guard, then the worker's own code — as in the main thread.
  const wt = await import('node:worker_threads');
  const { syncBuiltinESMExports } = await import('node:module');
  const prelude = `(${installRecorder.toString()})(${JSON.stringify(out)}, 'worker');\n`;
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const path = (await import('node:path')).default;
  class RecordingWorker extends Worker {
    constructor(filename, options = {}) {
      const opts = { ...options };
      let body;
      if (opts.eval) body = String(filename);
      else {
        const raw = String(filename instanceof URL ? filename.href : filename);
        const f = raw.startsWith('file:') ? fileURLToPath(raw) : path.resolve(raw);
        body = /\.mjs$/i.test(f) ? `import(${JSON.stringify(pathToFileURL(f).href)});` : `require(${JSON.stringify(f)});`;
      }
      opts.eval = true;
      super(prelude + body, opts);
    }
  }
  wt.default.Worker = RecordingWorker;
  syncBuiltinESMExports();

  if (process.env['CL_TEST_WORKER_PROBE'] === '1') {
    setTimeout(() => {
      const W = wt.default.Worker;
      const w = new W(
        "const s = require('node:net').connect(9, '192.0.2.1');"
        + "s.on('connect', () => { require('node:worker_threads').parentPort.postMessage('CONNECTED'); s.destroy(); });"
        + "s.on('error', (e) => require('node:worker_threads').parentPort.postMessage(e.code || 'ERROR'));",
        { eval: true },
      );
      w.once('message', (code) => {
        fs.appendFileSync(out, `${JSON.stringify({ kind: 'worker-probe', code: String(code), guarded: W !== RecordingWorker })}\n`);
        void w.terminate();
      });
      w.once('error', (e) => fs.appendFileSync(out, `${JSON.stringify({ kind: 'worker-probe', code: `error:${e.message}` })}\n`));
    }, 3000).unref();
  }
}
