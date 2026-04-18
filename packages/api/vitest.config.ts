// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
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
