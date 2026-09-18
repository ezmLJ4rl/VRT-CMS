import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component tests run against a real DOM (jsdom) so behaviour — not just markup —
// is covered. Kept separate from vite.config.js so the dev server's proxy and
// /admin/ base never leak into the test run.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    clearMocks: true,
    // Vitest's default cutoff is 5s, which is a limit on the MACHINE, not on the
    // behaviour: a single test here drives a whole page — typing through
    // userEvent, a 300ms debounced search, re-renders after each response — and
    // when the suite runs several files in parallel on a loaded machine, tests
    // that pass in isolation are killed mid-flight instead of failing an
    // assertion. Raised deliberately, only for this client, so a real hang still
    // fails in seconds while a slow machine cannot manufacture failures.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
