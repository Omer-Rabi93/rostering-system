import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// `vitest.config.ts` doesn't set `test.globals: true`, so Testing Library's
// framework auto-detection (which relies on a global `afterEach`) never
// fires. Without this, each render() leaks its DOM into the next test.
afterEach(() => {
  cleanup();
});
