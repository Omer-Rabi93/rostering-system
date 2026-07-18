import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src

const ENTRY = resolve(__dirname, 'PublicSchedulePage.tsx');

// Bare specifiers that are themselves direct proof of a dependency on the authenticated store —
// found anywhere in the import graph, this fails immediately regardless of relative-path
// resolution (a page could theoretically import 'react-redux' without going through
// `store/index.ts`, e.g. `useSelector` used ad hoc).
const FORBIDDEN_BARE_SPECIFIERS = ['react-redux', '@reduxjs/toolkit'];

const IMPORT_RE = /import\s+(?:type\s+)?(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (spec) specifiers.push(spec);
  }
  return specifiers;
}

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base.endsWith('.js') ? base.replace(/\.js$/, suffix) : base + suffix;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Statically walks `PublicSchedulePage.tsx`'s own relative-import graph (within `apps/web/src`
 * only — external packages like `@rostering/ui`/`react-router-dom` aren't followed, since they
 * can't reach `apps/web`'s own store) and asserts it never reaches `api/baseApi.ts`, any
 * `api/*.api.ts` domain-injected-endpoints file, or `store/index.ts` — the concrete, automated
 * version of "this page ships no authenticated API access" the implementation plan calls for,
 * rather than a manual claim.
 */
function collectImportGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, 'utf8');
    for (const specifier of extractImportSpecifiers(source)) {
      if (FORBIDDEN_BARE_SPECIFIERS.includes(specifier)) {
        throw new Error(`${file} imports forbidden bare specifier "${specifier}"`);
      }
      if (!specifier.startsWith('.')) continue; // external package — not followed
      const resolved = resolveRelative(file, specifier);
      if (resolved && resolved.startsWith(SRC_ROOT) && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return visited;
}

describe('PublicSchedulePage import-graph isolation', () => {
  it('never reaches api/baseApi.ts, any api/*.api.ts endpoint file, or the Redux store', () => {
    const graph = collectImportGraph(ENTRY);

    expect(graph.size).toBeGreaterThan(1); // sanity: the walk actually followed some imports

    const offenders = [...graph].filter(
      (file) =>
        file.endsWith('/api/baseApi.ts') ||
        /\/api\/[^/]+\.api\.ts$/.test(file) ||
        file.endsWith('/store/index.ts') ||
        file.endsWith('/store/hooks.ts'),
    );

    expect(offenders).toEqual([]);
  });

  it('does not import react-redux or @reduxjs/toolkit anywhere in its own graph', () => {
    // collectImportGraph itself throws on a forbidden bare specifier — reaching this line without
    // throwing already proves the property; this test exists so a regression shows up as a
    // specific, separately-named failure rather than only inside the graph-isolation test above.
    expect(() => collectImportGraph(ENTRY)).not.toThrow();
  });
});
