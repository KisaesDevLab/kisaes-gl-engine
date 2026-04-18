-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- Generic OpenAI-compatible provider columns.
--
-- Adds configuration for a second self-hosted option that speaks the
-- OpenAI-compatible `/v1/chat/completions` protocol. This covers
-- Ollama's `/v1` interface, llama.cpp's built-in server, LM Studio,
-- vLLM, and any other service that mimics the OpenAI schema. The
-- dedicated Ollama provider (native `/api/chat`) and the GLM-OCR
-- provider stay because they use server-specific features.
--
-- All-additive; safe to re-run under the IF NOT EXISTS guards.

ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS openai_compat_base_url VARCHAR(500),
  ADD COLUMN IF NOT EXISTS openai_compat_api_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS openai_compat_model VARCHAR(100);
