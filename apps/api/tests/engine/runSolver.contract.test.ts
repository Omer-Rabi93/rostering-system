// Node<->Python contract test (Phase 4, Part D).
//
// Covers three things:
//  1. The exact `spawn()` call the implementation makes is inspected (via a mocked
//     `node:child_process`) to prove the security property from the design doc: a FIXED argv
//     array containing only the interpreter + script path, `shell: false`, and the problem JSON
//     going exclusively over stdin -- never argv, never env. This is verified against the real
//     call the implementation makes, not merely asserted in prose.
//  2. A real `python3 solver/solve_roster.py` (this repo's `solver/.venv` interpreter, which has
//     `ortools` installed) is spawned with a small, realistic problem fixture, and the resulting
//     solution is asserted to round-trip through `engine/problem.ts`'s `parseSolverSolution`.
//  3. Malformed solver stdout (simulated via a test-only env var the solver script reads, see
//     `solver/solve_roster.py`'s `SOLVER_TEST_EMIT_GARBAGE` hatch) is rejected -- `runSolver`'s
//     promise rejects rather than resolving with partially-trusted data, so nothing downstream
//     could ever persist it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolverProblem } from '../../src/engine/problem.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(currentDir, '../../../..');
const VENV_PYTHON = path.resolve(REPO_ROOT, 'solver/.venv/bin/python3');

const SAMPLE_PROBLEM: SolverProblem = {
  days: ['2026-02-01', '2026-02-02'],
  workers: [
    {
      id: 1,
      role: 'GENERAL_GUARD',
      minMonthlyHours: 0,
      maxMonthlyHours: 200,
      availability: {
        '2026-02-01': ['A', 'B', 'C'],
        '2026-02-02': ['A', 'B', 'C'],
      },
    },
  ],
  requirements: [
    { date: '2026-02-01', shift: 'A', role: 'GENERAL_GUARD', requiredCount: 1 },
    { date: '2026-02-02', shift: 'A', role: 'GENERAL_GUARD', requiredCount: 1 },
  ],
};

describe('runSolver — spawn contract (mocked child_process)', () => {
  // Fake ChildProcess: a plain EventEmitter with `stdin`/`stdout`/`stderr` that behaves enough
  // like the real thing (writable stdin captured verbatim, stdout/stderr as real streams so
  // `.setEncoding`/`.on('data', ...)` work exactly as they do against a real child process).
  function createFakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdin: { written: string; ended: boolean; end: (chunk?: string) => void };
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = {
      written: '',
      ended: false,
      end(chunk?: string) {
        if (chunk) this.written += chunk;
        this.ended = true;
      },
    };
    return child;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // `vi.doMock` registrations persist across tests/describe blocks until explicitly undone --
    // without this, the "real python3" describe block below would silently keep receiving this
    // fake, never-resolving child_process mock and hang until the test timeout.
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('spawns with a fixed 2-element argv, shell:false, and writes problem JSON only to stdin', async () => {
    const fakeChild = createFakeChild();
    const spawnSpy = vi.fn().mockReturnValue(fakeChild);
    vi.doMock('node:child_process', () => ({ spawn: spawnSpy }));

    const { runSolver } = await import('../../src/engine/runSolver.js');

    const resultPromise = runSolver(SAMPLE_PROBLEM, { pythonExecutable: 'python3' });

    // Resolve the fake process as if the solver ran successfully.
    fakeChild.stdout.end(JSON.stringify({ assignments: [], alerts: [] }));
    fakeChild.emit('close', 0, null);

    await resultPromise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [command, args, spawnOptions] = spawnSpy.mock.calls[0] as [
      string,
      string[],
      { shell?: boolean },
    ];

    // The command is the interpreter; args is EXACTLY [scriptPath] -- no problem/user data.
    expect(command).toBe('python3');
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/solve_roster\.py$/);
    expect(spawnOptions.shell).toBe(false);

    // None of the problem's own data (a worker id, a date, a role string) ever appears in argv.
    const argvJoined = args.join(' ');
    expect(argvJoined).not.toContain('2026-02-01');
    expect(argvJoined).not.toContain('GENERAL_GUARD');

    // The problem travelled exclusively over stdin, as the exact JSON the caller passed in.
    expect(fakeChild.stdin.ended).toBe(true);
    expect(JSON.parse(fakeChild.stdin.written)).toEqual(SAMPLE_PROBLEM);
  });

  it('rejects when the process exits non-zero', async () => {
    const fakeChild = createFakeChild();
    vi.doMock('node:child_process', () => ({ spawn: vi.fn().mockReturnValue(fakeChild) }));

    const { runSolver } = await import('../../src/engine/runSolver.js');
    const resultPromise = runSolver(SAMPLE_PROBLEM, { pythonExecutable: 'python3' });

    fakeChild.stderr.end('boom');
    fakeChild.emit('close', 1, null);

    await expect(resultPromise).rejects.toThrow(/exited with code 1/);
  });
});

describe('runSolver — real python3 solver/solve_roster.py process', () => {
  afterEach(() => {
    delete process.env.SOLVER_TEST_EMIT_GARBAGE;
  });

  it('gets a real solution back and it round-trips through parseSolverSolution', async () => {
    const { runSolver } = await import('../../src/engine/runSolver.js');
    const { parseSolverSolution } = await import('../../src/engine/problem.js');

    const solution = await runSolver(SAMPLE_PROBLEM, { pythonExecutable: VENV_PYTHON });

    expect(solution.assignments.length).toBeGreaterThan(0);
    expect(solution.assignments.every((a) => a.workerId === 1)).toBe(true);

    // Round-trip: re-serializing and re-parsing the already-validated solution through the same
    // Zod parser yields an identical object -- the parser is not lossy or order-dependent.
    const roundTripped = parseSolverSolution(JSON.stringify(solution));
    expect(roundTripped).toEqual(solution);
  });

  it('rejects malformed (non-JSON) solver stdout instead of resolving with partial data', async () => {
    const { runSolver } = await import('../../src/engine/runSolver.js');

    process.env.SOLVER_TEST_EMIT_GARBAGE = 'invalid_json';

    await expect(runSolver(SAMPLE_PROBLEM, { pythonExecutable: VENV_PYTHON })).rejects.toThrow(
      /invalid JSON/,
    );
  });

  it('rejects solver stdout that is valid JSON but fails the solution schema', async () => {
    const { runSolver } = await import('../../src/engine/runSolver.js');

    process.env.SOLVER_TEST_EMIT_GARBAGE = 'invalid_schema';

    await expect(runSolver(SAMPLE_PROBLEM, { pythonExecutable: VENV_PYTHON })).rejects.toThrow();
  });
});
