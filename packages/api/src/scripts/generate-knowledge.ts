// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Standalone CLI for the chat assistant's knowledge base generator.
 *
 * Usage:
 *   npm run --workspace packages/api generate-knowledge
 *
 * Or, from inside the dev container:
 *   docker compose -f docker-compose.yml -f docker-compose.dev.yml \
 *     exec -T api node_modules/.bin/tsx packages/api/src/scripts/generate-knowledge.ts
 *
 * The actual generation logic lives in
 * `services/chat-knowledge-generator.ts` so the admin "regenerate"
 * endpoint and this script run identical code paths.
 */

import { generateKnowledge } from '../services/chat-knowledge-generator.js';

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Vibe MyBooks — Chat Knowledge Generator');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const result = await generateKnowledge();

  console.log('');
  console.log(`Curated source files: ${result.data.curated.files.length}`);
  for (const f of result.data.curated.files) {
    console.log(`  - ${f}`);
  }
  console.log(`Curated total: ${(result.data.curated.totalBytes / 1024).toFixed(1)} KB`);
  console.log('');
  console.log(`Screens extracted: ${result.data.screens.length}`);
  console.log(`Workflows: ${result.data.workflows.length}`);
  console.log(`Glossary terms: ${result.data.glossaryTerms.length}`);
  console.log('');
  console.log(`Wrote: ${result.jsonPath}`);
  console.log(`Wrote: ${result.promptPath}`);
  console.log(`Total prompt size: ${(result.promptText.length / 1024).toFixed(1)} KB (~${Math.ceil(result.promptText.length / 4)} tokens)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch((err) => {
  console.error('Knowledge generation failed:', err);
  process.exit(1);
});
