import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { KnowledgeData } from './chat-knowledge-generator.js';

/**
 * Loads the AI assistant's knowledge base.
 *
 * The generator (see chat-knowledge-generator.ts) writes two artifacts:
 *
 *   - `app-knowledge-prompt.md`  — the formatted system prompt the
 *                                   chat service injects on every
 *                                   completion call
 *   - `app-knowledge.json`       — structured data the admin status
 *                                   panel reads to display screen,
 *                                   workflow, and term counts
 *
 * Both files are read once and cached. Call `reloadKnowledge()` to
 * pick up changes after running `npm run generate-knowledge` or after
 * the admin "regenerate" endpoint runs the generator.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedPrompt: string | null = null;
let cachedData: KnowledgeData | null = null;

function knowledgeDir(): string {
  // The files live under packages/api/src/knowledge/. Walk a few
  // candidates so this works in dev (tsx), compiled (dist), and from
  // /app inside the dev container.
  const candidates = [
    path.resolve(__dirname, '..', 'knowledge'),
    path.resolve(__dirname, '..', '..', 'src', 'knowledge'),
    path.resolve(process.cwd(), 'packages', 'api', 'src', 'knowledge'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]!;
}

function promptFilePath(): string {
  return path.join(knowledgeDir(), 'app-knowledge-prompt.md');
}

function dataFilePath(): string {
  return path.join(knowledgeDir(), 'app-knowledge.json');
}

export function getKnowledgePrompt(): string {
  if (cachedPrompt !== null) return cachedPrompt;
  const filePath = promptFilePath();
  try {
    cachedPrompt = fs.readFileSync(filePath, 'utf8');
    return cachedPrompt;
  } catch (err: any) {
    // The chat feature is non-essential — if the file is missing we
    // log and return a minimal fallback so the assistant can still
    // answer questions, just without app-specific knowledge.
    console.error(`[chat-knowledge] Failed to load ${filePath}:`, err.message);
    cachedPrompt = FALLBACK_PROMPT;
    return cachedPrompt;
  }
}

export function getKnowledgeData(): KnowledgeData | null {
  if (cachedData !== null) return cachedData;
  const filePath = dataFilePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    cachedData = JSON.parse(text) as KnowledgeData;
    return cachedData;
  } catch (err: any) {
    console.error(`[chat-knowledge] Failed to parse ${filePath}:`, err.message);
    return null;
  }
}

export function reloadKnowledge(): void {
  cachedPrompt = null;
  cachedData = null;
}

/** Backwards-compatible alias used by chat.routes.ts. */
export function reloadKnowledgePrompt(): void {
  reloadKnowledge();
}

/** Approximate token count using the 4-chars-per-token rule of thumb. */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface KnowledgeStats {
  byteLength: number;
  estimatedTokens: number;
  hasPromptFile: boolean;
  hasDataFile: boolean;
  promptFilePath: string;
  dataFilePath: string;
  // Counts from the structured JSON, if it exists
  screenCount: number | null;
  workflowCount: number | null;
  termCount: number | null;
  curatedFileCount: number | null;
  generatedAt: string | null;
}

export function getKnowledgeStats(): KnowledgeStats {
  const pPath = promptFilePath();
  const dPath = dataFilePath();
  const prompt = getKnowledgePrompt();
  const data = getKnowledgeData();
  return {
    byteLength: prompt.length,
    estimatedTokens: estimateTokenCount(prompt),
    hasPromptFile: fs.existsSync(pPath),
    hasDataFile: fs.existsSync(dPath),
    promptFilePath: pPath,
    dataFilePath: dPath,
    screenCount: data?.screens.length ?? null,
    workflowCount: data?.workflows.length ?? null,
    termCount: data?.glossaryTerms.length ?? null,
    curatedFileCount: data?.curated.files.length ?? null,
    generatedAt: data?.generatedAt ?? null,
  };
}

const FALLBACK_PROMPT = `You are the Vibe MyBooks Assistant, an in-app help guide for a self-hosted bookkeeping application. Be concise, friendly, and never give tax or legal advice. Never create or modify data on the user's behalf — guide them to the right screen instead.`;
