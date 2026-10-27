// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Production dependency audit gate (dependency-audit.yml).
//
// Runs `npm audit --omit=dev --json` and fails on any HIGH or CRITICAL
// advisory, except those listed in scripts/audit-exceptions.json. An
// exception names one advisory, the package, why it cannot be fixed yet, the
// mitigation in place, and an expiry date: once that date passes the gate
// fails on it again, so an exception can never be forgotten. Every active
// exception is printed on each run.
//
// Usage: node scripts/audit-gate.mjs            (exit 1 on failure)
//        AUDIT_GATE_TODAY=YYYY-MM-DD overrides "today" for testing expiry.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exceptionsFile = resolve(here, 'audit-exceptions.json');
const BLOCKING = new Set(['high', 'critical']);

const today = process.env.AUDIT_GATE_TODAY ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  console.error(`audit-gate: AUDIT_GATE_TODAY must be YYYY-MM-DD (got ${today})`);
  process.exit(2);
}

const exceptions = JSON.parse(readFileSync(exceptionsFile, 'utf8'));
for (const e of exceptions) {
  for (const k of ['advisory', 'package', 'reason', 'mitigation', 'expires']) {
    if (typeof e[k] !== 'string' || !e[k]) {
      console.error(`audit-gate: exception is missing "${k}": ${JSON.stringify(e)}`);
      process.exit(2);
    }
  }
}

// npm audit exits 1 when it finds anything; the JSON is still complete.
let raw;
try {
  // A fixed command string (no user input), so a shell is safe on every platform.
  raw = execSync('npm audit --omit=dev --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  raw = err.stdout;
  if (!raw) {
    console.error('audit-gate: npm audit produced no output');
    process.exit(2);
  }
}
const report = JSON.parse(raw);
const vulns = Object.values(report.vulnerabilities ?? {});

const advisoryUrlsOf = (v) =>
  (v.via ?? []).filter((x) => typeof x === 'object' && x.url).map((x) => x.url);
const ghsaOf = (url) => url.split('/').pop();

let failed = false;
const active = [];
for (const v of vulns) {
  if (!BLOCKING.has(v.severity)) continue;
  const urls = advisoryUrlsOf(v);
  // A transitive finding "via" another package carries no advisory of its
  // own; it is covered by the finding of that package.
  if (urls.length === 0) continue;
  const covering = urls.map((u) => exceptions.find((e) => e.advisory === ghsaOf(u) && e.package === v.name));
  if (covering.length > 0 && covering.every(Boolean)) {
    for (const e of covering) {
      if (e.expires < today) {
        failed = true;
        console.error(`audit-gate: exception for ${e.package} (${e.advisory}) expired on ${e.expires}; fix the advisory or renew the exception with a new review.`);
      } else {
        active.push(e);
      }
    }
    continue;
  }
  failed = true;
  console.error(`audit-gate: ${v.severity} advisory in ${v.name} (${v.range}): ${urls.join(', ')}`);
}

for (const e of [...new Set(active)]) {
  console.log(`audit-gate: EXCEPTION ${e.package} ${e.advisory} until ${e.expires}\n  reason:     ${e.reason}\n  mitigation: ${e.mitigation}`);
}
const m = report.metadata?.vulnerabilities ?? {};
console.log(`audit-gate: production audit: ${m.critical ?? 0} critical, ${m.high ?? 0} high, ${m.moderate ?? 0} moderate (dev dependencies omitted)`);
if (failed) process.exit(1);
console.log('audit-gate: passed');
