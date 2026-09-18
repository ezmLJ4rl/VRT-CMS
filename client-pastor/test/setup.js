import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// jsdom has no matchMedia; DataTable uses it to render ONE layout — the
// desktop table by default, so tests exercise the grid most screens show.
// A test wanting the narrow card view stubs it to `matches: false`.
window.matchMedia =
  window.matchMedia ||
  ((query) => ({
    matches: query.includes('min-width'),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  }));

// Unmount whatever a test rendered so each one starts from an empty document.
afterEach(() => {
  cleanup();
});
