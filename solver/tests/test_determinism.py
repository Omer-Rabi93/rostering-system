"""Same problem JSON -> identical solution JSON, across independent process runs.

CP-SAT is seeded (random_seed=42), single-threaded (num_search_workers=1), and time-limited
(max_time_in_seconds=30) specifically so a re-run of the same roster-generation job converges on
the same output (see `docs/design/rostering-system-design.html`'s determinism decision, and the
implementation plan's roster-generation job being idempotent on retry).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from conftest import full_requirements_matrix, make_worker

SOLVER_SCRIPT = Path(__file__).resolve().parent.parent / "solve_roster.py"


def _run_solver(problem: dict) -> str:
    result = subprocess.run(
        [sys.executable, str(SOLVER_SCRIPT)],
        input=json.dumps(problem),
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def _fixture_problem() -> dict:
    days = ["2026-02-01", "2026-02-02", "2026-02-03"]
    workers = [
        make_worker(1, role="GENERAL_GUARD", min_hours=16, max_hours=80, days=days),
        make_worker(2, role="GENERAL_GUARD", min_hours=16, max_hours=80, days=days),
        make_worker(3, role="GENERAL_GUARD", min_hours=16, max_hours=80, days=days),
        make_worker(4, role="SUPERVISOR", min_hours=8, max_hours=80, days=days),
    ]
    requirements = full_requirements_matrix(
        days,
        counts={("A", "GENERAL_GUARD"): 1, ("B", "GENERAL_GUARD"): 1, ("A", "SUPERVISOR"): 1},
    )
    return {"days": days, "workers": workers, "requirements": requirements}


def test_two_independent_process_runs_produce_byte_identical_stdout() -> None:
    problem = _fixture_problem()

    first_run = _run_solver(problem)
    second_run = _run_solver(problem)

    assert first_run == second_run

    # Sanity: this isn't trivially true because the output is empty -- assert real content exists.
    solution = json.loads(first_run)
    assert len(solution["assignments"]) > 0


def test_determinism_holds_even_with_an_unsatisfiable_slot_present() -> None:
    # A role with demand but zero eligible workers forces the solver to exercise its shortfall
    # slack path too -- determinism must hold there as well, not just on the easy feasible path.
    days = ["2026-02-01"]
    workers = [make_worker(1, role="GENERAL_GUARD", min_hours=0, max_hours=40, days=days)]
    requirements = full_requirements_matrix(days, counts={("A", "SCREENER"): 2})
    problem = {"days": days, "workers": workers, "requirements": requirements}

    first_run = _run_solver(problem)
    second_run = _run_solver(problem)

    assert first_run == second_run
    solution = json.loads(first_run)
    assert any(a["type"] == "unfillable_slot" and a["missing"] == 2 for a in solution["alerts"])
