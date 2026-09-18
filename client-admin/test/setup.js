import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Testing Library gives its async queries one second by default. That is a
// limit on the MACHINE, not on the app: these screens debounce their searches
// (300ms) and re-render after each response, so when the suite runs several
// files in parallel the wait can lose to scheduling alone and a passing test
// reports a timeout instead. Raised once, here, rather than sprinkled through
// the suites — a genuine hang still fails, just later.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no matchMedia; DataTable uses it to render ONE layout — the
// desktop table by default, so the app's tests exercise the grid that most
// screens show. A test that wants the narrow card view stubs it to
// `matches: false` (see DataTable.test.jsx).
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
