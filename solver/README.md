# Roster Solver (Python / OR-Tools)

Plain Python directory (not a pnpm workspace member) containing the CP-SAT
scheduling sidecar invoked by the `apps/api` worker process (Phase 4/6).

## Setup

```bash
cd solver
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt        # runtime only (ortools)
pip install -r requirements-dev.txt    # + pytest, for running solver/tests/
```

## Contract

`solve_roster.py` reads a single JSON "problem" document from stdin and
writes a single JSON "solution" document to stdout. It is invoked as:

```bash
python3 solve_roster.py < problem.json
```

No problem data is ever passed via argv or environment variables.

## Tests

Python tests (pytest) live under `solver/tests/`:

```bash
cd solver
source .venv/bin/activate
python3 -m pytest tests/ -v
```
