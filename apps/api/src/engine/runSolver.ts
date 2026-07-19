// Spawns the Python CP-SAT solver sidecar (`solver/solve_roster.py`) and returns its parsed,
// Zod-validated solution.
//
// This module MUST NOT import from express, @prisma/client, or pg-boss — see
// `no-restricted-imports` in eslint.config.js scoped to `src/engine/**`.
//
// SECURITY CONTRACT (design doc): the solver is invoked as
// `spawn(pythonExecutable, [scriptPath], { shell: false })` — a FIXED, 2-element argv array
// containing only the interpreter and the script path, both constants resolved by this module
// (or explicitly overridden by the caller for local dev / tests), never derived from problem or
// user data. The entire problem JSON travels over stdin. No problem-derived value is ever
// interpolated into argv, env, or a shell string, so untrusted roster data can never reach a
// command line / shell.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { SolverProblem, SolverSolution } from './problem.js';
import { parseSolverSolution } from './problem.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repo-root `solver/solve_roster.py`, resolved relative to this module's own file location (never
 * from argv/env/cwd) — a build-time constant, not attacker-influenced.
 * `apps/api/src/engine/runSolver.ts` -> repo root is 4 levels up.
 */
export const DEFAULT_SOLVER_SCRIPT_PATH = path.resolve(
  currentDir,
  '../../../../solver/solve_roster.py',
);

export interface RunSolverOptions {
  /** Defaults to `$SOLVER_PYTHON_PATH` or plain `python3` on `PATH` (the production contract). */
  readonly pythonExecutable?: string;
  readonly scriptPath?: string;
  /**
   * Node-side kill timeout. The solver's own internal CP-SAT time budget is no longer a single
   * flat constant -- it's banded by active-workforce size (`solve_roster.py`'s
   * `compute_time_budget_seconds`, 30s up to 1800s) -- so there is no longer one universal "safe"
   * default here. The real caller, `RosterGenerationService`, always computes and passes this
   * explicitly (`engine/timeBudget.ts#computeNodeSolverTimeoutMs`, mirroring the exact same
   * worker-count-based bands the Python side uses, plus headroom), so the two sides can never
   * disagree about the deadline. `DEFAULT_TIMEOUT_MS` below only exists for callers that don't
   * (e.g. ad hoc scripts/tests invoking `runSolver` directly against a small fixture) -- it matches
   * the smallest (<=200-worker) band's Node-side timeout exactly, so it stays correct for exactly
   * the cases that don't care about scale.
   */
  readonly timeoutMs?: number;
}

export class SolverProcessError extends Error {}

/** Matches `engine/timeBudget.ts#computeNodeSolverTimeoutMs(200)` (the <=200-worker band's 30s
 * CP-SAT budget + 5s headroom) -- the fallback for callers that don't pass an explicit
 * workforce-size-derived `timeoutMs` (see `RunSolverOptions.timeoutMs`'s doc comment). */
const DEFAULT_TIMEOUT_MS = 35_000;

export function runSolver(
  problem: SolverProblem,
  options: RunSolverOptions = {},
): Promise<SolverSolution> {
  const pythonExecutable =
    options.pythonExecutable ?? process.env.SOLVER_PYTHON_PATH ?? 'python3';
  const scriptPath = options.scriptPath ?? DEFAULT_SOLVER_SCRIPT_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    // Fixed argv: [scriptPath] only. Problem data is never appended here — it is written to
    // stdin below, and nowhere else.
    const child = spawn(pythonExecutable, [scriptPath], { shell: false, timeout: timeoutMs });

    let stdout = '';
    let stderr = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      reject(new SolverProcessError(`Failed to spawn solver process: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (code !== 0) {
        const signalNote = signal ? ` (signal ${signal})` : '';
        reject(
          new SolverProcessError(
            `Solver process exited with code ${String(code)}${signalNote}: ${stderr}`,
          ),
        );
        return;
      }
      try {
        resolve(parseSolverSolution(stdout));
      } catch (err) {
        reject(err instanceof Error ? err : new SolverProcessError(String(err)));
      }
    });

    // The problem JSON travels exclusively over stdin — never argv, never env, never a shell
    // string.
    child.stdin?.end(JSON.stringify(problem));
  });
}
