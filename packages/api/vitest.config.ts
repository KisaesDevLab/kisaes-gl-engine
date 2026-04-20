// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // globalSetup runs ONCE before the suite boots — the right place for
    // schema migrations so every DB-touching test observes the same
    // schema. setupFiles runs per-file and is reserved for per-test env
    // vars and module-reset hooks.
    globalSetup: ['./src/test-global-setup.ts'],
    setupFiles: ['./src/test-setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    sequence: {
      concurrent: false,
    },
    // Bumped from vitest's 5s default. A handful of tests bcrypt-hash
    // ~10 recovery codes at cost 12; on slower CI runners that legit
    // takes 6–8s. Setting this globally is simpler than sprinkling
    // per-test `timeout:` overrides and matches the cost-12 policy.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
