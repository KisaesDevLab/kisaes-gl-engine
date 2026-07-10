// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Image-OCR vision fallback chain. The primary OCR model (MiniCPM-V) reads
// most documents, but a cold/flaky local model or an unparseable response
// shouldn't fail the job outright. This runs an ordered chain:
//
//   1. primary  — the resolved OCR model (config.ocrModel || OCR_VISION_MODEL),
//                 on the self-hosted endpoint (MiniCPM-V by default)
//   2. local    — OCR_FALLBACK_MODEL (qwen3.5), same self-hosted endpoint
//   3. cloud    — Anthropic, ONLY when an Anthropic key is set AND cloud
//                 vision is enabled (assertCloudVisionAllowed). On the default
//                 appliance cloud vision is off, so the chain is local-only and
//                 no image ever leaves the box.
//
// An attempt "fails over" when completeWithImage throws OR returns a
// CompletionResult with parseError (non-JSON / empty content). The first clean
// result wins; if all fail, the last result is returned so the caller's normal
// unwrapParsed surfaces ai_parse_failed (or the last thrown error is rethrown).

import { getProvider, hasCredentials } from './ai-providers/index.js';
import type { VisionParams, CompletionResult } from './ai-providers/ai-provider.interface.js';
import * as orchestrator from './ai-orchestrator.service.js';
import { env } from '../config/env.js';
import { log } from '../utils/logger.js';
import { withTimeout } from '../utils/retry.js';

type RawConfig = Parameters<typeof getProvider>[1];

export interface VisionFallbackCtx {
  rawConfig: RawConfig;
  /** The self-hosted provider name (e.g. 'openai_compat' / 'ollama'). */
  ocrProvider: string;
  /** Resolved primary model — config.ocrModel || env.OCR_VISION_MODEL. */
  primaryModel: string;
  /** For logs/audit (e.g. 'ocr_receipt'). */
  task?: string;
  /** M3: per-function wall-clock budget (resolveTaskExec(...).timeoutMs). Each
   *  attempt is raced against this so a stalled local vision model can't hang
   *  the request indefinitely; on timeout the chain fails over to the next
   *  attempt. Absent → no wall-clock cap (unchanged behaviour). */
  timeoutMs?: number;
}

interface Attempt {
  label: string;
  build: () => ReturnType<typeof getProvider>;
}

export async function completeVisionWithFallback(
  params: VisionParams,
  ctx: VisionFallbackCtx,
): Promise<CompletionResult> {
  const { rawConfig, ocrProvider, primaryModel } = ctx;
  const attempts: Attempt[] = [
    { label: `primary:${primaryModel}`, build: () => getProvider(ocrProvider, rawConfig, primaryModel) },
  ];

  // Local fallback (qwen) — same self-hosted endpoint, different model. Skip
  // when it would just repeat the primary tag.
  if (env.OCR_FALLBACK_MODEL && env.OCR_FALLBACK_MODEL !== primaryModel) {
    attempts.push({
      label: `local:${env.OCR_FALLBACK_MODEL}`,
      build: () => getProvider(ocrProvider, rawConfig, env.OCR_FALLBACK_MODEL),
    });
  }

  // Cloud fallback (Anthropic) — only with a key AND cloud vision enabled.
  // assertCloudVisionAllowed throws when disabled; we swallow that so the
  // chain simply stays local. This sends the image off-box, so it is opt-in.
  if (hasCredentials('anthropic', rawConfig)) {
    let cloudAllowed = false;
    try {
      await orchestrator.assertCloudVisionAllowed('anthropic');
      cloudAllowed = true;
    } catch {
      cloudAllowed = false;
    }
    if (cloudAllowed) {
      attempts.push({ label: 'cloud:anthropic', build: () => getProvider('anthropic', rawConfig) });
    }
  }

  let lastResult: CompletionResult | undefined;
  let lastError: unknown;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    try {
      const provider = attempt.build();
      // M3: race each attempt against the per-function timeout when set. A
      // TimeoutError is treated like any other attempt failure → fail over.
      const call = provider.completeWithImage(params);
      if (ctx.timeoutMs) call.catch(() => { /* swallow late rejection after timeout */ });
      const result = ctx.timeoutMs
        ? await withTimeout(call, ctx.timeoutMs, `vision.completeWithImage(${attempt.label})`)
        : await call;
      if (!result.parseError) {
        if (i > 0) {
          log.warn({
            component: 'ai-vision-fallback',
            event: 'vision_fallback_used',
            task: ctx.task ?? null,
            used: attempt.label,
            cloud: attempt.label.startsWith('cloud:'),
          });
        }
        return result;
      }
      lastResult = result;
      log.warn({
        component: 'ai-vision-fallback',
        event: 'vision_attempt_unparseable',
        task: ctx.task ?? null,
        attempt: attempt.label,
        next: attempts[i + 1]?.label ?? null,
      });
    } catch (err) {
      lastError = err;
      log.warn({
        component: 'ai-vision-fallback',
        event: 'vision_attempt_failed',
        task: ctx.task ?? null,
        attempt: attempt.label,
        next: attempts[i + 1]?.label ?? null,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Every attempt failed. Prefer returning the last result so the caller's
  // unwrapParsed surfaces the standard ai_parse_failed; otherwise rethrow.
  if (lastResult) return lastResult;
  throw lastError ?? new Error('All OCR vision attempts failed');
}
