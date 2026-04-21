// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Update-check service — hits the GitHub Releases API to tell a super
// admin whether a newer Vibe MyBooks image has been published.
//
// Explicitly does NOT apply updates. The happy-path flow is:
//   1. operator clicks "Check for updates" in Settings → System
//   2. this service returns { current, latest, isNewer, releaseUrl, ... }
//   3. UI shows the banner + manual instructions to pull + bounce compose
//
// We never drive docker compose from inside the container — that
// requires mounting /var/run/docker.sock which would give a single
// auth bypass root-equivalent on the host. Operators stay in control
// of the actual upgrade step; we just close the "I had no idea a new
// version existed" gap.

import { env } from '../config/env.js';

const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/KisaesDevLab/Vibe-MyBooks/releases/latest';
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface UpdateCheckResult {
  /** The version the running appliance identifies as. "dev" when built
   *  locally, "unknown" when nothing has stamped the image, otherwise
   *  a release tag like "v1.2.3". */
  current: string;
  /** The newest release tag on GitHub (e.g. "v1.3.0"), or null when
   *  the check failed. */
  latest: string | null;
  /** True iff both current + latest parsed as semver and latest > current. */
  isNewer: boolean;
  /** Direct link to the GitHub release page — the UI uses this for
   *  "View release notes". */
  releaseUrl: string | null;
  /** ISO 8601 timestamp of when GitHub published the latest release. */
  publishedAt: string | null;
  /** Markdown body from the release — capped to 8KB to keep the
   *  response predictable. UI renders this in a scrollable pane. */
  releaseNotes: string | null;
  /** Unix ms timestamp when this result was produced. The UI shows
   *  "last checked N minutes ago" so operators know if the answer is
   *  stale. */
  checkedAt: number;
  /** Populated only when the GitHub call failed — the UI shows this
   *  in lieu of a version comparison so air-gapped / rate-limited
   *  installs get a real explanation instead of "unknown". */
  error?: string;
}

interface GithubReleaseResponse {
  tag_name: string;
  html_url: string;
  published_at: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
}

let cache: { result: UpdateCheckResult; expiresAt: number } | null = null;

/**
 * Return the image's self-identified version. Preference order:
 *   1. VIBE_MYBOOKS_VERSION (stamped into the image by the Dockerfile ARG)
 *   2. VIBE_MYBOOKS_TAG (the compose override — operator-set)
 *   3. literal "unknown" — running from source via tsx, no stamp applied.
 */
export function getCurrentVersion(): string {
  const stamped = env.VIBE_MYBOOKS_VERSION?.trim();
  if (stamped) return stamped;
  const tag = process.env['VIBE_MYBOOKS_TAG']?.trim();
  if (tag) return tag;
  return 'unknown';
}

/**
 * Parse a "vX.Y.Z" / "X.Y.Z" string into numeric parts. Returns null
 * for values that don't match — "latest", "dev", "unknown", and also
 * RC/beta tags like "v1.2.3-rc.1" (we intentionally ignore prereleases
 * for isNewer comparisons).
 */
function parseSemver(raw: string): [number, number, number] | null {
  const m = raw.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * True iff `candidate` is strictly greater than `current`. Unparseable
 * values return false — safer than assuming "unknown < anything",
 * which would spam every air-gapped appliance with a useless banner.
 */
export function isNewerVersion(current: string, candidate: string): boolean {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i]! > a[i]!) return true;
    if (b[i]! < a[i]!) return false;
  }
  return false;
}

function truncateNotes(body: string | undefined): string | null {
  if (!body) return null;
  const MAX = 8 * 1024;
  if (body.length <= MAX) return body;
  return body.slice(0, MAX) + '\n\n…(truncated)';
}

async function fetchLatestRelease(): Promise<GithubReleaseResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(GITHUB_LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // User-Agent is REQUIRED by GitHub's API or the request 403s.
        'User-Agent': 'vibe-mybooks-update-check',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}`);
    }
    const data = (await res.json()) as GithubReleaseResponse;
    if (!data.tag_name) {
      throw new Error('GitHub API response missing tag_name');
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check whether an update is available. Cached for 5 minutes (soft
 * cap, configurable via force=true) so a super admin mashing the
 * button can't burn GitHub's 60-requests-per-hour anonymous quota in
 * a single session.
 */
export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const now = Date.now();
  if (!force && cache && cache.expiresAt > now) {
    return cache.result;
  }

  const current = getCurrentVersion();
  let result: UpdateCheckResult;

  try {
    const release = await fetchLatestRelease();
    const latest = release.tag_name;
    result = {
      current,
      latest,
      isNewer: isNewerVersion(current, latest),
      releaseUrl: release.html_url,
      publishedAt: release.published_at,
      releaseNotes: truncateNotes(release.body),
      checkedAt: now,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Cache the failure for a shorter window so a transient outage
    // doesn't pin the UI to "unavailable" for the full 5 minutes.
    result = {
      current,
      latest: null,
      isNewer: false,
      releaseUrl: null,
      publishedAt: null,
      releaseNotes: null,
      checkedAt: now,
      error: message,
    };
    cache = { result, expiresAt: now + 30_000 };
    return result;
  }

  cache = { result, expiresAt: now + CACHE_TTL_MS };
  return result;
}

// Test hook — clears the cache between cases.
export const __internal = {
  reset(): void { cache = null; },
  parseSemver,
  GITHUB_LATEST_RELEASE_URL,
  FETCH_TIMEOUT_MS,
  CACHE_TTL_MS,
};
