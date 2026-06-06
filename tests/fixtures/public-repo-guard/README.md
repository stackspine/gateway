# Public-Repo-Guard Fixture Library

Each subdirectory under `tests/fixtures/public-repo-guard/` is a synthetic
mini-tree that exercises one rule enforced by
`.github/workflows/public-repo-guard.yml` (and its local mirror
`scripts/guard.sh`).

Layout convention:

```
tests/fixtures/public-repo-guard/
  pass/<case>/      # MUST exit 0 (clean)
  fail/<case>/      # MUST exit 1 (blocked)
```

The harness `scripts/run-guard-fixtures.sh` iterates every fixture and asserts
the expected outcome. CI runs it on every push and pull request via
`.github/workflows/guard-fixtures.yml`, so any regression in either the rules
or the fixtures is caught immediately.

Adding a new rule:
1. Add the pattern to `scripts/guard.sh` and `public-repo-guard.yml`.
2. Add at least one `fail/<case>/` fixture that the new rule blocks.
3. Add at least one `pass/<case>/` fixture that resembles the failing case
   but stays within bounds (the negative control).
