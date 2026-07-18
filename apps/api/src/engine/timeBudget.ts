// Solver time-budget banding -- the TS-side mirror of `solver/solve_roster.py`'s
// `compute_time_budget_seconds`, which is the ACTUAL source of truth CP-SAT's own
// `max_time_in_seconds` is set from (computed Python-side, straight off `len(problem['workers'])`
// in the problem JSON it already receives -- no wire-format change needed, since that array is
// already there). This TS copy exists for exactly one reason: `rosterGenerationService.ts` needs
// to know, BEFORE the solve even starts, what budget the Python process is about to give itself,
// so it can hand `runSolver.ts` a Node-side kill timeout comfortably above it. If the two sides
// ever disagreed, the Node side could kill the solver process before its own internal deadline,
// turning a would-be-successful large solve into a false timeout -- see `runSolver.ts`'s
// `RunSolverOptions.timeoutMs` doc comment.
//
// Keeping this logic in two places (rather than, say, having Python emit its computed budget back
// over some side channel before solving) is deliberate: the alternative would mean the Node side
// can't know the timeout to apply to `spawn(..., { timeout })` until AFTER the child process has
// already started and told it -- but Node's `timeout` option only accepts a value at spawn time.
// Parity between this file's bands and `solve_roster.py`'s is enforced by
// `apps/api/tests/engine/timeBudget.test.ts`'s dedicated cross-language test, which spawns the
// real Python interpreter and diffs its output against this function's -- not just independently
// hand-maintained tests on each side that could quietly drift apart.
//
// See `compute_time_budget_seconds`'s doc comment in `solve_roster.py` for the full banding
// rationale (heuristic starting point given CP-SAT's problem-dependent performance, not a
// guarantee; the <=200 band is this repo's original, already-proven-and-tested flat 30s value).

interface TimeBudgetBand {
  readonly maxWorkers: number;
  readonly budgetSeconds: number;
}

/** Must stay byte-for-byte in sync with `solve_roster.py`'s `TIME_BUDGET_BANDS` -- see this
 * module's header comment for how that's enforced (a cross-language parity test, not just hope). */
const TIME_BUDGET_BANDS: readonly TimeBudgetBand[] = [
  { maxWorkers: 200, budgetSeconds: 30 },
  { maxWorkers: 1_000, budgetSeconds: 600 },
  { maxWorkers: 5_000, budgetSeconds: 600 },
  { maxWorkers: 10_000, budgetSeconds: 1200 },
];

/** Above the largest band (beyond this system's stated 10k-worker target): capped here rather
 * than scaled further -- see `solve_roster.py`'s identical constant for the "graceful degradation,
 * not a bug" reasoning. */
const TIME_BUDGET_ABOVE_MAX_WORKERS_SECONDS = 1800;

/** Pure function: active-workforce size -> the CP-SAT time budget (seconds) the Python solver is
 * about to compute for itself from the same worker count. See this module's header comment. */
export function computeSolverTimeBudgetSeconds(workerCount: number): number {
  for (const band of TIME_BUDGET_BANDS) {
    if (workerCount <= band.maxWorkers) {
      return band.budgetSeconds;
    }
  }
  return TIME_BUDGET_ABOVE_MAX_WORKERS_SECONDS;
}

/** Headroom added on top of the Python-side time budget before it becomes the Node-side `spawn`
 * kill timeout -- covers process startup/teardown, stdin/stdout IPC, and JSON
 * serialize/deserialize overhead on both ends, none of which CP-SAT's own internal clock accounts
 * for. Matches this repo's original flat-budget convention (`DEFAULT_TIMEOUT_MS` was 35_000 against
 * a 30_000ms solver budget -- exactly this same 5s margin), now applied on top of whichever band
 * actually applies instead of always the smallest one. */
const NODE_TIMEOUT_HEADROOM_MS = 5_000;

/** The Node-side `spawn(..., { timeout })` kill timeout that corresponds to a given active-worker
 * count -- ALWAYS comfortably above (`computeSolverTimeBudgetSeconds(workerCount) * 1000 +`
 * headroom) the budget the Python process will independently compute for itself from that exact
 * same worker count, so the two sides can never disagree in a way that kills a would-be-successful
 * solve early. */
export function computeNodeSolverTimeoutMs(workerCount: number): number {
  return computeSolverTimeBudgetSeconds(workerCount) * 1000 + NODE_TIMEOUT_HEADROOM_MS;
}
