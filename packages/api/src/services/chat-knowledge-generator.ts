// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Knowledge base generator.
 *
 * Walks the React Router config in `packages/web/src/App.tsx`, extracts
 * a screen catalog (path → component → file → page title → action
 * buttons), merges it with the hand-curated markdown files under
 * `packages/api/src/knowledge/curated/`, and writes two artifacts:
 *
 *   - `app-knowledge.json`        — structured data (consumed by the
 *                                    admin status panel)
 *   - `app-knowledge-prompt.md`   — formatted Markdown system prompt
 *                                    that the chat service injects
 *                                    into every chat completion
 *
 * The generator is intentionally regex-based rather than AST-based:
 * the routing file is well-structured and the speed/simplicity
 * tradeoff is worth it. If the parser ever drifts, the curated
 * markdown files still cover the substance — the auto-extracted
 * screen catalog is icing.
 */

// ─── Path resolution ───────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function repoRoot(): string {
  // From packages/api/src/services/, walk up to the repo root.
  // Try a few candidates so this works in both dev (tsx) and
  // compiled (dist) layouts, plus when invoked from /app inside
  // the dev container.
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', '..'),
    path.resolve(process.cwd()),
    path.resolve(process.cwd(), '..', '..'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'packages', 'web', 'src', 'App.tsx'))) {
      return candidate;
    }
  }
  return candidates[0]!;
}

function knowledgeDir(): string {
  return path.join(repoRoot(), 'packages', 'api', 'src', 'knowledge');
}

function curatedDir(): string {
  return path.join(knowledgeDir(), 'curated');
}

function webFeaturesDir(): string {
  return path.join(repoRoot(), 'packages', 'web', 'src', 'features');
}

function appTsxPath(): string {
  return path.join(repoRoot(), 'packages', 'web', 'src', 'App.tsx');
}

// ─── Types ─────────────────────────────────────────────────────

export interface ScreenEntry {
  /** Stable, kebab-case identifier (e.g., 'enter-bill') */
  id: string;
  /** URL path from the router (e.g., '/bills/new') */
  path: string;
  /** Component name as imported in App.tsx */
  component: string;
  /** Source file relative to repo root */
  sourceFile: string | null;
  /** Page title scraped from the component's first <h1> */
  title: string;
  /** Top-level UI section this screen belongs to */
  section: string;
  /** Action button labels detected in the page (best-effort) */
  actions: string[];
}

export interface KnowledgeData {
  generatedAt: string;
  curated: {
    files: string[];
    totalBytes: number;
  };
  screens: ScreenEntry[];
  workflows: { title: string }[];
  glossaryTerms: string[];
}

// ─── Curated markdown loader ───────────────────────────────────

function loadCurated(): { combined: string; files: string[]; bytes: number } {
  const dir = curatedDir();
  if (!fs.existsSync(dir)) {
    return { combined: '', files: [], bytes: 0 };
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const parts: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8').trim();
    parts.push(text);
    bytes += text.length;
  }
  return { combined: parts.join('\n\n'), files, bytes };
}

// ─── App.tsx parser ────────────────────────────────────────────

interface ImportedComponent {
  name: string;
  sourceFile: string; // relative to repo root
}

function parseImports(appTsxSrc: string): Map<string, ImportedComponent> {
  // Match: import { Foo } from './path/to/Foo';
  // Skip namespace, default, and side-effect imports.
  const importRe = /import\s*\{\s*([^}]+?)\s*\}\s*from\s*['"](\.\/.+?)['"];?/g;
  const result = new Map<string, ImportedComponent>();
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(appTsxSrc)) !== null) {
    const namesPart = match[1]!;
    const importPath = match[2]!;
    const names = namesPart
      .split(',')
      .map((n) => n.trim().replace(/\s+as\s+\w+$/, '').trim())
      .filter(Boolean);
    for (const name of names) {
      // Resolve the relative path from the import statement to a
      // repo-rooted source file. App.tsx lives at
      // packages/web/src/App.tsx, so './foo' = packages/web/src/foo.
      const resolved = path.posix.join('packages/web/src', importPath);
      // Try .tsx, then .ts
      const baseRel = resolved.replace(/^\.\//, '');
      result.set(name, {
        name,
        sourceFile: baseRel.endsWith('.tsx') || baseRel.endsWith('.ts')
          ? baseRel
          : `${baseRel}.tsx`,
      });
    }
  }
  return result;
}

interface RawRoute {
  path: string;
  component: string;
}

function parseRoutes(appTsxSrc: string): RawRoute[] {
  // Match: <Route path="/foo" element={<FooPage />} />
  // We only care about the simple element form — generic ad-hoc
  // <GenericReport ... /> entries can be picked up too because the
  // component name is GenericReport, but their `title="..."` prop
  // is what humans care about, so we capture that separately.
  const re = /<Route\s+path=["']([^"']+)["']\s+element=\{<([A-Z]\w+)([^>]*?)\/?>\s*\}\s*\/>/g;
  const routes: RawRoute[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(appTsxSrc)) !== null) {
    routes.push({ path: match[1]!, component: match[2]! });
  }
  return routes;
}

function parseGenericReportTitles(appTsxSrc: string): Map<string, string> {
  // Map from path → title for routes that use the GenericReport
  // wrapper, since the component name is the same for all of them.
  // Match: <Route path="/foo" element={<GenericReport title="Foo Report" ...
  const re = /<Route\s+path=["']([^"']+)["']\s+element=\{<GenericReport\s+title=["']([^"']+)["']/g;
  const result = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(appTsxSrc)) !== null) {
    result.set(match[1]!, match[2]!);
  }
  return result;
}

// ─── Page file scraper ─────────────────────────────────────────

function safeReadFile(absolutePath: string): string | null {
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function extractH1Title(src: string): string | null {
  // First <h1>...text...</h1> with the simplest cases:
  //   <h1 className="...">Bills</h1>
  //   <h1 className="...">{isEdit ? 'Edit Bill' : 'Enter Bill'}</h1>
  //   <h1 className="...">Some Title</h1>
  const re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/;
  const match = src.match(re);
  if (!match) return null;
  const inner = match[1]!.trim();

  // Try literal text first
  const literalMatch = inner.match(/^([A-Za-z][^<{]*?)$/);
  if (literalMatch) return literalMatch[1]!.trim();

  // Text followed by JSX (e.g., "Bill {bill.txnNumber}\n<span...>"):
  // extract the leading text before the first JSX element or expression.
  const leadingTextMatch = inner.match(/^([A-Za-z][^<{]*?)\s*[{<]/);
  if (leadingTextMatch) {
    const text = leadingTextMatch[1]!.trim();
    if (text.length >= 3) return text;
  }

  // Then ternary: {isEdit ? 'Edit Bill' : 'Enter Bill'}
  // Take the second branch (the "create" form is the more common one)
  const ternaryMatch = inner.match(/\?\s*['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/);
  if (ternaryMatch) return ternaryMatch[2]!;

  // Single string: {'Title'}
  const stringMatch = inner.match(/['"]([^'"]+)['"]/);
  if (stringMatch) return stringMatch[1]!;

  return null;
}

function extractActionButtons(src: string): string[] {
  // Pull labels from <Button>...</Button> patterns. Best-effort:
  // we cap at 6 unique labels per page so the catalog doesn't blow up.
  //
  // Looks like a button label = starts with an uppercase letter,
  // 3+ chars, no slashes, and doesn't contain code-y characters
  // like `(` `=>` `?` `&`. This filters out things that match a
  // string literal but are clearly an event handler arg or path.
  const labels = new Set<string>();

  const isLabelLike = (s: string): boolean => {
    if (s.length < 3 || s.length > 60) return false;
    if (!/^[A-Z]/.test(s)) return false;
    if (/[\/(){}<>=&?]/.test(s)) return false;
    return true;
  };

  const buttonRe = /<Button[^>]*?>([\s\S]*?)<\/Button>/g;
  let match: RegExpExecArray | null;
  while ((match = buttonRe.exec(src)) !== null) {
    const inner = match[1]!.trim();

    // Plain text: "Save Changes" — possibly with surrounding whitespace
    const plain = inner.replace(/\s+/g, ' ');
    if (/^[A-Z][\w +\-]*$/.test(plain)) {
      labels.add(plain);
      if (labels.size >= 6) break;
      continue;
    }

    // Ternary: {isEdit ? 'Save Changes' : 'Create Bill'}
    // Take whichever branch looks most label-like.
    const allStrings = Array.from(inner.matchAll(/['"]([^'"\n]+)['"]/g)).map((m) => m[1]!);
    for (const s of allStrings) {
      if (isLabelLike(s)) {
        labels.add(s);
        if (labels.size >= 6) break;
      }
    }
    if (labels.size >= 6) break;
  }

  return Array.from(labels);
}

function deriveSection(routePath: string): string {
  if (routePath === '/') return 'Dashboard';
  const segment = routePath.split('/').filter(Boolean)[0] || '';
  switch (segment) {
    case 'admin': return 'Admin';
    case 'settings': return 'Settings';
    case 'reports': return 'Reports';
    case 'banking': return 'Banking';
    case 'invoices': return 'Sales';
    case 'bills':
    case 'pay-bills':
    case 'vendor-credits':
      return 'Expenses';
    case 'transactions': return 'Transactions';
    case 'checks': return 'Expenses';
    case 'contacts': return 'Contacts';
    case 'accounts': return 'Accounts';
    case 'budgets': return 'Budgeting';
    case 'reports': return 'Reports';
    default:
      return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
  }
}

function deriveScreenId(routePath: string, component: string): string {
  // Common-case mapping: '/bills/new' → 'enter-bill',
  // '/pay-bills' → 'pay-bills', '/' → 'dashboard'.
  if (routePath === '/') return 'dashboard';

  // Preserve the dashed form of the URL path, stripping params and
  // empty segments. /bills/:id/edit → bills-edit
  const cleaned = routePath
    .split('/')
    .filter((s) => s && !s.startsWith(':'))
    .join('-');

  if (cleaned) return cleaned;

  // Fall back to the component name, kebab-cased.
  return component.replace(/Page$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

// ─── Public API ────────────────────────────────────────────────

export interface GenerateOptions {
  /** Don't write files; just compute the data and return it. */
  dryRun?: boolean;
  /** Skip the screen catalog (for testing). */
  skipScreens?: boolean;
}

export interface GenerateResult {
  data: KnowledgeData;
  promptText: string;
  jsonPath: string;
  promptPath: string;
  /** True iff files were actually written to disk. */
  written: boolean;
}

export async function generateKnowledge(opts: GenerateOptions = {}): Promise<GenerateResult> {
  const curated = loadCurated();
  const screens: ScreenEntry[] = [];

  if (!opts.skipScreens) {
    const appSrc = safeReadFile(appTsxPath());
    if (appSrc) {
      const imports = parseImports(appSrc);
      const routes = parseRoutes(appSrc);
      const genericTitles = parseGenericReportTitles(appSrc);

      // Per-component title cache so we only read each file once
      // even when a component is reused (e.g., InvoiceForm at both
      // /invoices/new and /invoices/:id/edit).
      const titleCache = new Map<string, { title: string; actions: string[] }>();

      for (const route of routes) {
        // Skip auth/setup pages — the chat is only available
        // post-login, so the assistant doesn't need to know about
        // them.
        if (route.path.startsWith('/login')) continue;
        if (route.path.startsWith('/register')) continue;
        if (route.path.startsWith('/forgot-password')) continue;
        if (route.path.startsWith('/reset-password')) continue;
        if (route.path.startsWith('/auth/')) continue;
        if (route.path.startsWith('/oauth/')) continue;
        if (route.path === '/first-run-setup') continue;

        const imported = imports.get(route.component);
        const sourceFile = imported?.sourceFile || null;

        let title = '';
        let actions: string[] = [];

        // GenericReport routes carry their title in a JSX prop, not
        // an h1, so prefer the prop when present.
        const genericTitle = genericTitles.get(route.path);
        if (genericTitle) {
          title = genericTitle;
        } else if (sourceFile) {
          const cached = titleCache.get(sourceFile);
          if (cached) {
            title = cached.title;
            actions = cached.actions;
          } else {
            const absolute = path.join(repoRoot(), sourceFile);
            const text = safeReadFile(absolute);
            if (text) {
              title = extractH1Title(text) || '';
              actions = extractActionButtons(text);
            }
            titleCache.set(sourceFile, { title, actions });
          }
        }

        if (!title) {
          // Fall back to the component name, humanized.
          title = route.component
            .replace(/Page$|Form$|Report$/, '')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .trim();
        }

        screens.push({
          id: deriveScreenId(route.path, route.component),
          path: route.path,
          component: route.component,
          sourceFile,
          title,
          section: deriveSection(route.path),
          actions,
        });
      }
    }
  }

  // Glossary terms: extract h3 headings from 10-terminology.md so the
  // count in the admin panel reflects the curated content.
  const glossaryTerms = extractTerms(curated.combined);
  const workflows = extractWorkflows(curated.combined);

  const data: KnowledgeData = {
    generatedAt: new Date().toISOString(),
    curated: { files: curated.files, totalBytes: curated.bytes },
    screens,
    workflows,
    glossaryTerms,
  };

  const promptText = buildPrompt(curated.combined, screens);
  const dir = knowledgeDir();
  const jsonPath = path.join(dir, 'app-knowledge.json');
  const promptPath = path.join(dir, 'app-knowledge-prompt.md');

  let written = false;
  if (!opts.dryRun) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    fs.writeFileSync(promptPath, promptText);
    written = true;
  }

  return { data, promptText, jsonPath, promptPath, written };
}

function extractTerms(combined: string): string[] {
  const re = /^###\s+(.+)$/gm;
  const terms = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(combined)) !== null) {
    const heading = match[1]!.trim();
    // Skip h3s that look like section subheadings (the workflows
    // file has "### Bill → Payment Workflow" etc., which we count
    // separately).
    if (/workflow/i.test(heading) || /question/i.test(heading)) continue;
    terms.add(heading);
  }
  return Array.from(terms);
}

function extractWorkflows(combined: string): { title: string }[] {
  const re = /^###\s+(.+?)\s*Workflow\s*$/gim;
  const workflows: { title: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(combined)) !== null) {
    workflows.push({ title: match[1]!.trim() });
  }
  return workflows;
}

function buildPrompt(curated: string, screens: ScreenEntry[]): string {
  const parts: string[] = [];
  parts.push(curated.trim());

  if (screens.length > 0) {
    // Group screens by section so the prompt has a coherent
    // hierarchy rather than 100 flat entries.
    const bySection = new Map<string, ScreenEntry[]>();
    for (const s of screens) {
      const list = bySection.get(s.section) || [];
      list.push(s);
      bySection.set(s.section, list);
    }
    const sectionOrder = [
      'Dashboard', 'Banking', 'Sales', 'Expenses', 'Transactions',
      'Contacts', 'Accounts', 'Budgeting', 'Reports', 'Settings', 'Admin',
    ];
    const sortedSections = Array.from(bySection.keys()).sort((a, b) => {
      const ai = sectionOrder.indexOf(a);
      const bi = sectionOrder.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    parts.push('\n\n## Screen Catalog (auto-generated)\n');
    parts.push('The following screens exist in the application. Use these names and paths when directing users.\n');

    for (const section of sortedSections) {
      const list = bySection.get(section)!;
      parts.push(`\n### ${section}\n`);
      for (const s of list) {
        const actionPart = s.actions.length > 0 ? ` — actions: ${s.actions.join(', ')}` : '';
        parts.push(`- **${s.title}** (\`${s.path}\`)${actionPart}`);
      }
    }
  }

  return parts.join('\n');
}
