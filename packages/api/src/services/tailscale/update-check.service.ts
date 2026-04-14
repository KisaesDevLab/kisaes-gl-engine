import type { TailscaleUpdateCheck } from '@kis-books/shared';
import { getStatus } from './status.service.js';

const GITHUB_RELEASE_URL = 'https://api.github.com/repos/tailscale/tailscale/releases/latest';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 5000;
const UPGRADE_COMMAND = 'docker compose pull tailscale && docker compose up -d tailscale';

interface CachedCheck {
  result: TailscaleUpdateCheck;
  expiresAt: number;
}

let cache: CachedCheck | null = null;

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
}

// tailscaled reports version.Long() like "1.76.1-t12345-g6789abc" or
// "1.76.1-dev20240613-t..." — strip everything after the first non-numeric
// dot-segment to get the comparable "1.76.1" part.
export function parseSemverCore(raw: string): [number, number, number] | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^v/, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseSemverCore(latest);
  const b = parseSemverCore(current);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(GITHUB_RELEASE_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'vibe-mybooks-tailscale-update-check',
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub returned ${res.status}`);
    }
    return (await res.json()) as GitHubRelease;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkForUpdate(options: { force?: boolean } = {}): Promise<TailscaleUpdateCheck> {
  if (!options.force && cache && cache.expiresAt > Date.now()) {
    return cache.result;
  }

  let current = '';
  try {
    const status = await getStatus();
    current = status.version;
  } catch {
    // Keep empty; caller sees current: '' and can still show the latest.
  }

  let result: TailscaleUpdateCheck;
  try {
    const release = await fetchLatestRelease();
    const tag = release.tag_name ?? '';
    const latest = tag.replace(/^v/, '') || null;
    result = {
      current,
      latest,
      updateAvailable: !!latest && !!current && isNewer(latest, current),
      releaseUrl: release.html_url ?? null,
      releaseNotes: release.body?.slice(0, 2000) ?? null,
      upgradeCommand: UPGRADE_COMMAND,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    result = {
      current,
      latest: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseNotes: null,
      upgradeCommand: UPGRADE_COMMAND,
      checkedAt: new Date().toISOString(),
      error: (err as Error).message || 'Failed to reach GitHub',
    };
  }

  cache = { result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}
