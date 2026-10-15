// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Pins the server path: the BullMQ options, job names and concurrency that
// come out of JOB_SPECS must equal the constants services/extraction/queue.ts
// and the worker processors used before the JobQueue refactor.

import { describe, it, expect } from 'vitest';
import { JOB_SPECS } from './specs.js';
import { bullmqJobOptions } from './bullmq.adapter.js';
import { JOB_NAMES } from './job-queue.js';
import { env } from '../config/env.js';

// Verbatim copies of the pre-refactor constants.
const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};
const STATEMENT_PARSE_JOB_OPTIONS = { attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 };
const REPORT_PACK_JOB_OPTIONS = { attempts: 1, removeOnComplete: 500, removeOnFail: 1_000 };

describe('JOB_SPECS → BullMQ (server path unchanged)', () => {
  it('has exactly the six job types', () => {
    expect(Object.keys(JOB_SPECS).sort()).toEqual([...JOB_NAMES].sort());
  });

  it('job options per queue equal the former constants', () => {
    expect(bullmqJobOptions(JOB_SPECS['doc-render'])).toStrictEqual(DEFAULT_JOB_OPTIONS);
    expect(bullmqJobOptions(JOB_SPECS['doc-extract'])).toStrictEqual(DEFAULT_JOB_OPTIONS);
    expect(bullmqJobOptions(JOB_SPECS['statement-parse'])).toStrictEqual(STATEMENT_PARSE_JOB_OPTIONS);
    expect(bullmqJobOptions(JOB_SPECS['bill-capture'])).toStrictEqual(STATEMENT_PARSE_JOB_OPTIONS);
    expect(bullmqJobOptions(JOB_SPECS['report-pack'])).toStrictEqual(REPORT_PACK_JOB_OPTIONS);
    expect(bullmqJobOptions(JOB_SPECS['tax-param-ai-check'])).toStrictEqual(REPORT_PACK_JOB_OPTIONS);
  });

  it('BullMQ job names are the ones Queue.add used', () => {
    const names = Object.fromEntries(Object.entries(JOB_SPECS).map(([k, s]) => [k, s.bullmqJobName]));
    expect(names).toEqual({
      'doc-render': 'render',
      'doc-extract': 'extract',
      'statement-parse': 'parse',
      'bill-capture': 'extract',
      'report-pack': 'render',
      'tax-param-ai-check': 'check',
    });
  });

  it('worker concurrency is the processors’ setting', () => {
    expect(JOB_SPECS['doc-render'].concurrency()).toBe(2);
    expect(JOB_SPECS['doc-extract'].concurrency()).toBe(env.EXTRACTION_EXTRACT_CONCURRENCY);
    expect(JOB_SPECS['statement-parse'].concurrency()).toBe(env.STATEMENT_PARSE_CONCURRENCY);
    expect(JOB_SPECS['bill-capture'].concurrency()).toBe(env.BILL_CAPTURE_CONCURRENCY);
    expect(JOB_SPECS['report-pack'].concurrency()).toBe(1);
    expect(JOB_SPECS['tax-param-ai-check'].concurrency()).toBe(1);
  });

  it('log labels and completed-lines match the processors', () => {
    const labels = Object.fromEntries(
      Object.entries(JOB_SPECS).map(([k, s]) => [k, [s.logLabel, s.logCompleted]]),
    );
    expect(labels).toEqual({
      'doc-render': ['doc-render', false],
      'doc-extract': ['doc-extract', false],
      'statement-parse': ['statement-parse', true],
      'bill-capture': ['bill-capture', false],
      'report-pack': ['report-pack', true],
      'tax-param-ai-check': ['tax-ai-check', true],
    });
  });
});
