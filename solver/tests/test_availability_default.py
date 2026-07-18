"""Availability v3's one behavioral change to `solve_roster.py`: the per-(worker, date)
missing-availability-entry default flips from "unavailable that date" (`.get(date, [])`) to
"available every shift that date" (`.get(date, SHIFT_TYPES)`).

None of the OTHER test files in this suite exercise this default at all -- every fixture they build
passes `days=` to `make_worker`, which explicitly enumerates a shift subset for every date in
`days` (see `conftest.py#full_month_availability`), so a present-vs-missing distinction never
arises there. These are the only tests in the suite that actually prove the flipped default works.
"""

from __future__ import annotations

from conftest import full_requirements_matrix, make_worker
from solve_roster import solve


def test_worker_with_no_availability_entry_at_all_is_available_every_shift_every_date() -> None:
    # No `availability` map is passed at all -- mirrors a worker with zero `WorkerAvailability` rows
    # this month (Availability v3: absence means available for everything, not "assume
    # unavailable").
    days = ["2026-02-01", "2026-02-02"]
    worker = make_worker(1, role="GENERAL_GUARD", min_hours=0, max_hours=200)
    requirements = full_requirements_matrix(days, counts={("A", "GENERAL_GUARD"): 1})

    solution = solve({"days": days, "workers": [worker], "requirements": requirements})

    assert solution["alerts"] == []
    assignments = {(a["date"], a["shift"]) for a in solution["assignments"]}
    assert assignments == {("2026-02-01", "A"), ("2026-02-02", "A")}


def test_a_date_missing_from_the_map_and_a_date_explicitly_listing_every_shift_behave_identically() -> None:
    # 2026-02-01 has an explicit entry restricting the worker to shift A; 2026-02-02 has NO entry
    # at all. `requiredCount` for shift B applies uniformly to every day (per
    # `full_requirements_matrix`), so if the missing date were (wrongly) treated as unavailable,
    # the worker could never cover EITHER day's B requirement -- both days need it covered here.
    days = ["2026-02-01", "2026-02-02"]
    worker = make_worker(1, role="GENERAL_GUARD", min_hours=0, max_hours=200, availability={"2026-02-01": ["A"]})
    requirements = full_requirements_matrix(days, counts={("B", "GENERAL_GUARD"): 1})

    solution = solve({"days": days, "workers": [worker], "requirements": requirements})

    unfillable = [a for a in solution["alerts"] if a["type"] == "unfillable_slot"]
    # 2026-02-01: the worker is explicitly restricted to shift A, so the B requirement there is
    # unfillable -- proving the explicit entry is honored, not just "the flag is on so everything's
    # available." 2026-02-02 (no entry) IS covered -- proving the missing-date default.
    assert unfillable == [
        {"type": "unfillable_slot", "date": "2026-02-01", "shift": "B", "role": "GENERAL_GUARD", "missing": 1}
    ]
    assignments = {(a["date"], a["shift"]) for a in solution["assignments"]}
    assert ("2026-02-02", "B") in assignments


def test_an_explicit_empty_shift_list_for_a_date_still_means_unavailable_that_date() -> None:
    # An explicit `[]` entry (distinct from a MISSING date) is how a fully-excluded date
    # (`excludedShifts: 'ABC'`, inverted to `[]` before this JSON is built) is represented -- it
    # must still mean "no shifts available that date," not fall back to the missing-date default.
    days = ["2026-02-01"]
    worker = make_worker(1, role="GENERAL_GUARD", min_hours=0, max_hours=200, availability={"2026-02-01": []})
    requirements = full_requirements_matrix(days, counts={("A", "GENERAL_GUARD"): 1})

    solution = solve({"days": days, "workers": [worker], "requirements": requirements})

    assert solution["assignments"] == []
    unfillable = [a for a in solution["alerts"] if a["type"] == "unfillable_slot"]
    assert unfillable == [
        {"type": "unfillable_slot", "date": "2026-02-01", "shift": "A", "role": "GENERAL_GUARD", "missing": 1}
    ]
