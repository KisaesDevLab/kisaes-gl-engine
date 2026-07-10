<!--
Copyright 2026 Kisaes LLC
Licensed under the PolyForm Small Business License 1.0.0.
Free for small businesses; see LICENSE for terms.
-->

# Local Document Extraction (Qwen3.5 vision via Ollama)

Privacy-first extraction of structured data from uploaded financial documents
(PDFs, scans, images) using a **locally hosted** Qwen3.5 vision model served by
Ollama's OpenAI-compatible `/v1` endpoint. **No document or document-derived
data leaves the local perimeter.**

## Pipeline

```
POST /api/v1/extractions (multipart: file + docType)
  → sha256(file) → dedup by (tenant, file_hash)         [idempotent]
  → store original via the tenant StorageProvider
  → extraction_jobs row (status=pending) → enqueue doc-render → 202
[BullMQ doc-render]  (worker)
  → pdftoppm: PDF → page PNGs (images pass through)
  → store page images, extraction_pages rows, enqueue one doc-extract per page
[BullMQ doc-extract] (worker, concurrency-capped)
  → page image → Qwen3.5 vision (openai_compat provider, temperature 0, JSON)
  → Zod-validate → arithmetic/consistency checks → confidence gate
  → pass  → extracted_records (validated=true, posted=false)
     flag  → extraction_review_queue (NOT auto-posted)
  → finalize job: complete | needs_review | failed
```

## Compliance property — on-prem inference = no third-party disclosure

A CPA firm that processes client tax data through a **third-party** AI service may
trigger disclosure/consent obligations and data-handling duties. Running the model
**on infrastructure the firm controls** avoids third-party disclosure entirely:

- **IRC §7216 / Treas. Reg. §301.7216** — disclosing or using a client's tax-return
  information generally requires consent. On-prem inference is not a disclosure *to
  a third party*: the data never leaves the firm's box.
- **FTC Safeguards Rule (16 CFR Part 314)** — keeping document processing inside the
  controlled environment supports the required safeguards (access control,
  encryption at rest via the StorageProvider, audit logging) without expanding the
  data's exposure surface to an external processor.
- **AICPA Code §1.700 (Confidential Client Information)** — no client information is
  released to an outside party.

### How the code *enforces* it (not just documents it)

`qwen-client.service.ts` calls `assertCloudVisionAllowed('openai_compat')` **before**
sending any page image. That guard (in `ai-orchestrator.service.ts`) inspects the
configured endpoint URL and **returns cleanly only for a local URL** (loopback,
RFC-1918 private IP, `.local`, or a Docker/Compose short hostname) and **throws for
any public URL**. So a misconfiguration that pointed the model at a cloud endpoint
fails closed — the image is never transmitted. The PII sanitizer is correspondingly
a no-op (`none` mode) for the local endpoint because masking-before-send is moot when
nothing is sent off-box.

## Audit trail (every extraction is reconstructable)

Persisted and never discarded:

| Artefact | Where |
|---|---|
| Source file hash (sha256) | `extraction_jobs.file_hash` |
| Original file | StorageProvider `documents/{tenant}/{job}/original.*` |
| Rendered page images | `extraction_pages.image_ref` |
| Exact prompt sent | `extraction_pages.prompt` |
| Raw model response | `extraction_pages.raw_response` |
| Parsed/validated payload | `extracted_records.payload` |
| Model + quant tag | `extraction_jobs.model_tag` |
| Timestamps | `created_at` / `updated_at` / `completed_at` |

Job create and human review write-back are additionally recorded via `auditLog`.

## PII handling

TINs/SSNs are masked to the last four digits both by prompt instruction and again at
rest in `validate.ts` (defence in depth); account/routing numbers in bank-statement
descriptions are masked (runs of 6+ digits → `****####`). The module never stores a
full TIN/SSN.

## WISP note

For a firm's **Written Information Security Plan**: this module performs all document
inference on firm-controlled infrastructure. The only network egress in the extract
path is to the configured **local** Ollama endpoint, enforced at runtime by
`assertCloudVisionAllowed`. Originals and rendered page images inherit the tenant's
configured storage policy (local disk or firm-controlled S3) and encryption at rest.
Low-confidence or arithmetic-inconsistent extractions are never auto-posted; they are
queued for human review.

## Configuration

- Feature gate: `DOCUMENT_EXTRACTION_V1=true` (per appliance).
- Render: `EXTRACTION_RENDER_DPI`, `EXTRACTION_RENDER_GRAYSCALE`.
- Model: `EXTRACTION_MODEL_TAG` (default `qwen3.5:35b-a3b`); the Ollama base URL +
  model live in the encrypted `ai_config` as the OpenAI-compatible provider.
- Gating: `EXTRACTION_CONFIDENCE_THRESHOLD` (default 0.85),
  `EXTRACTION_EXTRACT_CONCURRENCY` (default 2).
- Runtime dependency: `poppler-utils` (`pdftoppm`), installed in the worker image.
