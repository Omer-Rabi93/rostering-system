// `engine/timeBudget.ts` -- band-boundary unit tests plus a cross-language parity test proving
// this file's bands agree, byte-for-byte, with `solver/solve_roster.py`'s
// `compute_time_budget_seconds` (the real source of truth CP-SAT's own time budget is computed
// from). See `timeBudget.ts`'s header comment for why the logic exists in two places at all.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { computeNodeSolverTimeoutMs, computeSolverTimeBudgetSeconds } from '../../src/engine/timeBudget.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(currentDir, '../../../..');
const VENV_PYTHON = path.resolve(REPO_ROOT, 'solver/.venv/bin/python3');
const SOLVER_DIR = path.resolve(REPO_ROOT, 'solver');

describe('computeSolverTimeBudgetSeconds', () => {
  it.each([
    // Lower edge and interior of the <=200 band: the unchanged, already-proven 30s value.
    [0, 30],
    [1, 30],
    [150, 30],
    [200, 30],
    // Just above each boundary lands in the next band up, not the previous one.
    [201, 600],
    [1_000, 600],
    [1_001, 600],
    [5_000, 600],
    [5_001, 1200],
    [10_000, 1200],
    // Above the stated 10k target: capped, not scaled further.
    [10_001, 1800],
    [50_000, 1800],
  ])('worker count %i -> %i seconds', (workerCount, expectedSeconds) => {
    expect(computeSolverTimeBudgetSeconds(workerCount)).toBe(expectedSeconds);
  });
});

describe('computeNodeSolverTimeoutMs', () => {
  it('is always exactly 5s (the documented headroom) above the Python-side budget', () => {
    for (const workerCount of [0, 200, 201, 1_000, 1_001, 5_000, 5_001, 10_000, 10_001, 50_000]) {
      const budgetMs = computeSolverTimeBudgetSeconds(workerCount) * 1000;
      expect(computeNodeSolverTimeoutMs(workerCount)).toBe(budgetMs + 5_000);
    }
  });
});

describe('cross-language parity with solve_roster.py#compute_time_budget_seconds', () => {
  /** Spawns the real venv interpreter and calls the real Python function directly (not a
   * reimplementation) for every boundary worker count in one process, returning
   * `worker_count -> seconds` as parsed JSON -- proves the two sides' bands agree by actually
   * running both implementations, not by eyeballing that the two files "look the same". */
  function computeViaPython(workerCounts: readonly number[]): Record<number, number> {
    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(SOLVER_DIR)})`,
      'from solve_roster import compute_time_budget_seconds',
      `counts = ${JSON.stringify(workerCounts)}`,
      'print(json.dumps({str(c): compute_time_budget_seconds(c) for c in counts}))',
    ].join('\n');
    const result = spawnSync(VENV_PYTHON, ['-c', script], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`python3 -c failed (status ${String(result.status)}): ${result.stderr}`);
    }
    return JSON.parse(result.stdout) as Record<number, number>;
  }

  it('agrees with the Python solver on every band boundary', () => {
    const workerCounts = [0, 1, 150, 200, 201, 1_000, 1_001, 5_000, 5_001, 10_000, 10_001, 50_000];
    const pythonResults = computeViaPython(workerCounts);

    for (const workerCount of workerCounts) {
      const tsSeconds = computeSolverTimeBudgetSeconds(workerCount);
      const pythonSeconds = pythonResults[workerCount];
      expect(
        pythonSeconds,
        `Python compute_time_budget_seconds(${workerCount}) returned no value`,
      ).toBeDefined();
      expect(
        tsSeconds,
        `TS/Python disagree at worker_count=${workerCount}: TS=${tsSeconds}s, Python=${String(pythonSeconds)}s -- ` +
          'these two implementations must be updated together, see timeBudget.ts\'s header comment.',
      ).toBe(pythonSeconds);
    }
  });
});
