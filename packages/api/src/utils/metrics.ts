// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// In-process Prometheus-format metrics registry.
//
// We deliberately avoid the prom-client dependency: a self-hosted
// appliance rarely needs the full feature surface (histograms,
// summaries with percentile sketches), and keeping the runtime
// dependency surface small is an explicit operational goal. This
// module implements counters and gauges with the exposition format
// Prometheus and VictoriaMetrics can scrape, and nothing else.
//
// Every metric is module-level (one registry per process), read at
// request time by the /metrics handler. The handler itself is gated
// behind super-admin auth; expose on a separate port/path only after
// reviewing the data exposed, since scheduler counters can reveal
// tenant activity patterns.

type LabelValues = Record<string, string | number> | undefined;

interface CounterFamily {
  type: 'counter';
  help: string;
  values: Map<string, number>;
}

interface GaugeFamily {
  type: 'gauge';
  help: string;
  values: Map<string, number>;
}

type Family = CounterFamily | GaugeFamily;

const registry: Map<string, Family> = new Map();

function serializeLabels(labels: LabelValues): string {
  if (!labels) return '';
  const pairs = Object.keys(labels).sort().map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
  return pairs.length > 0 ? `{${pairs.join(',')}}` : '';
}

function getOrInit(name: string, help: string, type: 'counter' | 'gauge'): Family {
  const existing = registry.get(name);
  if (existing) return existing;
  const family: Family = type === 'counter'
    ? { type: 'counter', help, values: new Map() }
    : { type: 'gauge', help, values: new Map() };
  registry.set(name, family);
  return family;
}

/**
 * Increment a counter. Creates the metric on first use. Labels must
 * be the same set every time for a given metric name.
 */
export function incCounter(name: string, help: string, labels?: LabelValues, delta = 1): void {
  const family = getOrInit(name, help, 'counter');
  if (family.type !== 'counter') {
    throw new Error(`metric ${name} is a ${family.type}, not a counter`);
  }
  const key = serializeLabels(labels);
  family.values.set(key, (family.values.get(key) ?? 0) + delta);
}

/**
 * Record the current value of a gauge. Unlike a counter this can go
 * up or down; use it for "current" values (queue depth, last-tick
 * duration, time-since-last-event).
 */
export function setGauge(name: string, help: string, value: number, labels?: LabelValues): void {
  const family = getOrInit(name, help, 'gauge');
  if (family.type !== 'gauge') {
    throw new Error(`metric ${name} is a ${family.type}, not a gauge`);
  }
  const key = serializeLabels(labels);
  family.values.set(key, value);
}

/**
 * Convenience helper for timing a scheduler tick. Records:
 *   - `<prefix>_runs_total{result=...}` counter
 *   - `<prefix>_duration_ms` gauge (last-cycle duration)
 *   - `<prefix>_last_success_timestamp` gauge (seconds since epoch)
 *
 * Pass the result (ok|error|skipped) so the counter gets the right
 * label.
 */
export function recordSchedulerTick(prefix: string, durationMs: number, result: 'ok' | 'error' | 'skipped'): void {
  incCounter(`${prefix}_runs_total`, `Total ${prefix} scheduler cycles`, { result });
  setGauge(`${prefix}_duration_ms`, `Last ${prefix} cycle duration in ms`, durationMs);
  if (result === 'ok') {
    setGauge(`${prefix}_last_success_timestamp`, `Seconds since epoch of the last successful ${prefix} cycle`, Math.floor(Date.now() / 1000));
  }
}

/**
 * Render the registry in Prometheus text exposition format v0.0.4.
 * https://prometheus.io/docs/instrumenting/exposition_formats/
 */
export function renderMetrics(): string {
  const out: string[] = [];
  const names = Array.from(registry.keys()).sort();
  for (const name of names) {
    const family = registry.get(name)!;
    out.push(`# HELP ${name} ${family.help}`);
    out.push(`# TYPE ${name} ${family.type}`);
    const entries = Array.from(family.values.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [labels, value] of entries) {
      out.push(`${name}${labels} ${value}`);
    }
  }
  return out.join('\n') + '\n';
}

// Test hook — clears the registry so vitest cases are isolated.
export const __internal = {
  reset(): void { registry.clear(); },
  size(): number { return registry.size; },
};
