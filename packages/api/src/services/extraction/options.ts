// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Resolution for the document-extraction tuning knobs. Admin overrides live
// in ai_config.extraction_options (edited in System Settings → AI); each key
// falls back to its EXTRACTION_* env default when null/absent. This keeps the
// env vars as the deployment default while letting an admin tune per-appliance
// without a redeploy.

import type { ExtractionOptions } from '@kis-books/shared';
import { env } from '../../config/env.js';
import * as aiConfigService from '../ai-config.service.js';

export interface ResolvedExtractionOptions {
  maxTokens: number;
  numCtx: number;
  thinking: 'on' | 'off';
  ollamaNative: boolean;
  modelTag: string;
  renderDpi: number;
  grayscale: boolean;
  confidenceThreshold: number;
}

// `?? env` is correct even for booleans: an explicit `false` (e.g. grayscale
// off, ollamaNative off) is preserved because only null/undefined fall through.
// `extractionOptions` is a jsonb column (typed `unknown` by Drizzle), so we
// accept unknown and narrow here rather than casting at every call site.
export function resolveExtractionOptions(config: { extractionOptions?: unknown }): ResolvedExtractionOptions {
  const o = (config.extractionOptions ?? {}) as ExtractionOptions;
  return {
    maxTokens: o.maxTokens ?? env.EXTRACTION_MAX_TOKENS,
    numCtx: o.numCtx ?? env.EXTRACTION_NUM_CTX,
    thinking: o.thinking ?? env.EXTRACTION_THINKING,
    ollamaNative: o.ollamaNative ?? env.EXTRACTION_OLLAMA_NATIVE,
    modelTag: o.modelTag ?? env.EXTRACTION_MODEL_TAG,
    renderDpi: o.renderDpi ?? env.EXTRACTION_RENDER_DPI,
    grayscale: o.grayscale ?? env.EXTRACTION_RENDER_GRAYSCALE,
    confidenceThreshold: o.confidenceThreshold ?? env.EXTRACTION_CONFIDENCE_THRESHOLD,
  };
}

/** Fetch ai_config and resolve the extraction knobs in one call. */
export async function getResolvedExtractionOptions(): Promise<ResolvedExtractionOptions> {
  const config = await aiConfigService.getRawConfig();
  return resolveExtractionOptions(config as { extractionOptions?: ExtractionOptions | null });
}
