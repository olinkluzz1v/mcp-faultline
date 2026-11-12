# Saved report HTML conversion implementation plan

**Goal:** Convert an existing BatchReport JSON to offline HTML without executing
tasks, tools, agents, or grading again.

**Architecture:** A CLI-only command reads JSON, validates a complete batch using
the existing Zod dependency, recalculates statistics from validated runs, and
calls the existing HTML renderer. A temporary output file is installed only
after rendering succeeds; exclusive creation is the default, replacement needs
`--force`, and input aliases are rejected.

**Spec:** Maintainer request on 2026-11-12: `report <json> --out <html>`, legacy
unknown provenance, empty reports, useful nonzero errors, no input modification,
no new dependencies, README/reporting documentation, and an open PR for review.
Additional request: resolve deprecated GitHub Actions runtime and moving Ubuntu
image notices. Environment configuration is outside scope.

## Work and verification

- [x] Add failing CLI tests in `tests/report-command.test.mjs`: valid conversion
  from a directory without tasks, stored grades/metadata, stale statistics,
  legacy/empty data, malformed nested fields, non-batch input, escaping, required
  output, missing files, failed writes, overwrite opt-in, same-path/symlink/
  hard-link input aliases, and arbitrary task IDs.
- [x] Add `src/report/parse.ts` with `parseBatchReport(value: unknown): BatchReport`.
  Validate metadata, grades, trajectories and optional injection records without
  coercion or inferred provenance. Treat saved statistics as an unused object.
  Preserve supplied grades/metadata and use `computeStats` for all summaries.
- [x] Add `src/cli/report-command.ts` with
  `runReportCommand({ source, out, force? }): Promise<number>` and register it in
  `src/cli/index.ts`. Use `toHtml`, safe output installation, and phase-specific
  errors. No evaluation or task-directory access.
- [x] Make task statistics safe for JSON task IDs matching Object prototype keys.
- [x] Add the new CLI test file to `test:report`, already used by npm test and CI.
  Update the three GitHub Actions to verified Node 24 runtime releases and pin
  `ubuntu-24.04`; retain Node 20 as the project's compatibility test target.
- [x] Document the command, accepted input, recomputed statistics, file safety,
  and failure behavior in README.md and docs/reporting.md.
- [x] Run typecheck, build, npm test, test:all, and diff checks. Preserve previous
  generated reports.

Delivery: open the PR against this fork's main and report CI results. Leave it
open; the task-specific instruction overrides standing auto-merge.

## Review focus

- Reject invalid dates, non-finite values, malformed nested grades and provenance
  before rendering or touching existing output.
- Never follow an output symlink or truncate an input alias, even with --force.
- Protect existing output against concurrent non-force writers with exclusive
  installation; use replacement rather than in-place truncation with --force.
- Rebuild summaries even when saved stats are stale or incomplete; keep legacy
  missing provenance distinct from known zero injections.
- Exercise real CLI processes and files; inspect literal counts and unchanged
  input bytes, without relying solely on exit status or renderer snapshots.

## Local verification

Linux, Node 24.22.1, npm 11.9.0: typecheck/build passed; smoke 15/15, reporting
62/62 with no skips, embedded tasks 7/7, controls 21/21, replay MATCH. The initial
CLI checks failed on the missing command. Independent review found omitted
opaque JSON payloads and blocking FIFO input; both were reproduced and fixed
with regression tests. Remote CI evidence belongs to the PR checks.
