/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@rostering/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      // The bare `@rostering/ui` specifier is aliased straight to source (bypassing
      // package.json's `exports` map, which only the built `dist/` satisfies), so the
      // `./styles.css` subpath (Phase 9's `@rostering/ui/styles.css` import — tokens.css + kit.css,
      // consumed by `routes.tsx` and the public schedule page) needs its own explicit alias to the
      // built stylesheet for the same reason: it would otherwise fall through to plain node/vite
      // package resolution, which this alias'd bare specifier already opts out of.
      '@rostering/ui/styles.css': fileURLToPath(new URL('../../packages/ui/dist/styles/index.css', import.meta.url)),
      '@rostering/ui': fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // The public, unauthenticated worker-schedule page (`/schedule/:token`,
      // `usePublicSchedule.ts`) fetches `/api/schedule/:token` — living under `/api` (not the bare
      // `/schedule` the design doc originally sketched) specifically so it no longer shares a
      // literal path with the SPA's own `/schedule/:token` client-side route (`routes.tsx`). That
      // collision used to mean a browser's top-level navigation/reload for the page itself and
      // this route's own data fetch were indistinguishable to any proxy sitting in front of both
      // (this dev proxy and, in the composed stack, `infra/nginx.conf`) — see the Phase 11 E2E
      // report / Phase 12 fix for the full history. Now `/api/schedule/:token` is just another
      // route this single `/api` proxy entry already covers, and `/schedule/:token` itself is left
      // unproxied on purpose so the browser's own navigation reaches vite's dev server (which
      // serves `index.html`), never this proxy.
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
  },
});
