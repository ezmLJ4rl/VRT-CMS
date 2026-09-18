import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component tests run against a real DOM (jsdom) so behaviour — not just markup —
// is covered. Kept separate from vite.config.js so the PWA plugin and its
// service-worker generation never run during a test.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    clearMocks: true,
  },
});
