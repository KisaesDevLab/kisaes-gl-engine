// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach } from 'vitest';
import { incCounter, setGauge, renderMetrics, recordSchedulerTick, __internal } from './metrics.js';

describe('metrics registry', () => {
  beforeEach(() => {
    __internal.reset();
  });

  it('renders an empty registry as just a trailing newline', () => {
    expect(renderMetrics()).toBe('\n');
  });

  it('emits a single counter with HELP + TYPE lines', () => {
    incCounter('foo_total', 'Count of foos');
    const rendered = renderMetrics();
    expect(rendered).toContain('# HELP foo_total Count of foos');
    expect(rendered).toContain('# TYPE foo_total counter');
    expect(rendered).toContain('foo_total 1');
  });

  it('accumulates a counter across increments', () => {
    incCounter('bar_total', 'bars');
    incCounter('bar_total', 'bars', undefined, 5);
    incCounter('bar_total', 'bars');
    expect(renderMetrics()).toContain('bar_total 7');
  });

  it('writes labeled counter variants on separate lines', () => {
    incCounter('req_total', 'requests', { code: 200 });
    incCounter('req_total', 'requests', { code: 500 });
    incCounter('req_total', 'requests', { code: 200 });
    const out = renderMetrics();
    expect(out).toContain('req_total{code="200"} 2');
    expect(out).toContain('req_total{code="500"} 1');
  });

  it('escapes special characters inside label values', () => {
    incCounter('weird_total', 'weird', { reason: 'has "quote" and \\ slash' });
    expect(renderMetrics()).toContain('weird_total{reason="has \\"quote\\" and \\\\ slash"} 1');
  });

  it('supports gauges that replace (not accumulate) their value', () => {
    setGauge('temp_celsius', 'thermometer', 20);
    setGauge('temp_celsius', 'thermometer', 22);
    expect(renderMetrics()).toContain('temp_celsius 22');
  });

  it('rejects mixing counter and gauge under the same name', () => {
    incCounter('name', 'description');
    expect(() => setGauge('name', 'description', 1)).toThrow(/not a gauge/);
  });

  it('recordSchedulerTick emits runs_total, duration_ms, and last_success_timestamp on ok', () => {
    const before = Math.floor(Date.now() / 1000);
    recordSchedulerTick('backup', 420, 'ok');
    const after = Math.floor(Date.now() / 1000);
    const out = renderMetrics();
    expect(out).toContain('backup_runs_total{result="ok"} 1');
    expect(out).toContain('backup_duration_ms 420');
    const match = out.match(/backup_last_success_timestamp (\d+)/);
    expect(match).not.toBeNull();
    const ts = Number(match![1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('recordSchedulerTick on error does NOT bump last_success_timestamp', () => {
    recordSchedulerTick('backup', 100, 'error');
    const out = renderMetrics();
    expect(out).toContain('backup_runs_total{result="error"} 1');
    expect(out).not.toContain('backup_last_success_timestamp');
  });
});
