"""HARD (b): at most 2 shifts per worker per calendar date.

A single worker, available every shift, cannot be double- or triple-booked on one calendar date
even when demand for all 3 shifts that day is otherwise satisfiable only by them.
"""

from __future__ import annotations

from conftest import full_requirements_matrix, make_worker
from solve_roster import solve


def test_single_worker_never_gets_3_shifts_on_the_same_calendar_date() -> None:
    days = ["2026-02-01"]
    worker = make_worker(1, role="GENERAL_GUARD", min_hours=0, max_hours=200, days=days)
    requirements = full_requirements_matrix(
        days,
        counts={("A", "GENERAL_GUARD"): 1, ("B", "GENERAL_GUARD"): 1, ("C", "GENERAL_GUARD"): 1},
    )

    solution = solve({"days": days, "workers": [worker], "requirements": requirements})

    worker_1_shifts = [a for a in solution["assignments"] if a["workerId"] == 1]
    assert len(worker_1_shifts) <= 2

    # With demand for 3 shifts but only 1 eligible worker capped at 2, exactly one slot must raise
    # an unfillable_slot alert (missing=1) -- the cap doesn't just silently drop coverage.
    unfillable = [a for a in solution["alerts"] if a["type"] == "unfillable_slot"]
    assert len(unfillable) == 1
    assert unfillable[0]["missing"] == 1


def test_two_shifts_on_the_same_date_is_allowed() -> None:
    days = ["2026-02-01"]
    worker = make_worker(1, role="GENERAL_GUARD", min_hours=0, max_hours=200, days=days)
    requirements = full_requirements_matrix(
        days, counts={("A", "GENERAL_GUARD"): 1, ("B", "GENERAL_GUARD"): 1}
    )

    solution = solve({"days": days, "workers": [worker], "requirements": requirements})

    worker_1_shifts = {a["shift"] for a in solution["assignments"] if a["workerId"] == 1}
    assert worker_1_shifts == {"A", "B"}
    assert solution["alerts"] == []


def test_midnight_spanning_shift_c_then_next_day_shift_a_is_not_a_cap_violation() -> None:
    # Shift C (16:00-00:00) on day N followed by shift A on day N+1 for the same worker spans
    # midnight but touches two different calendar `date` keys, so the per-date cap of 2 does not
    # treat it as a violation (mirrors apps/api/src/engine/validator.ts's maxTwoShiftsPerDay rule).
    days = ["2026-02-01", "2026-02-02"]
    worker = make_worker(1, role="GENERAL_GUARD", min_hours=0, max_hours=200, days=days)
    # `counts` applies uniformly to every day, so build the C=1 matrix first, then hand-adjust:
    # day 1 needs only its C slot; day 2 needs only its A slot (its C demand is zeroed out) so the
    # solver has a reason to place the worker on both without any competing demand muddying which
    # slot they land in.
    requirements = full_requirements_matrix(days, counts={("C", "GENERAL_GUARD"): 1})
    for row in requirements:
        if row["date"] == "2026-02-02" and row["shift"] == "A" and row["role"] == "GENERAL_GUARD":
            row["requiredCount"] = 1
        if row["date"] == "2026-02-02" and row["shift"] == "C" and row["role"] == "GENERAL_GUARD":
            row["requiredCount"] = 0

    solution = solve({"days": days, "workers": [worker], "requirements": requirements})

    assignments = {(a["date"], a["shift"]) for a in solution["assignments"] if a["workerId"] == 1}
    assert assignments == {("2026-02-01", "C"), ("2026-02-02", "A")}
    assert solution["alerts"] == []
