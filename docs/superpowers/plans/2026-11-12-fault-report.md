# Fault statistics and offline report implementation plan

**Goal:** Add observed fault-type statistics and a standalone HTML report to the existing embedded workflow.

**Architecture:** Record actual injections alongside each run; aggregate run outcomes once per observed fault type. JSON, Markdown and HTML share the same statistical definitions. HTML is static, self-contained and uses native disclosures.

**Stack:** Existing TypeScript/Node >=20, built-in `node:test`, inline CSS; no new runtime dependencies.

## Scope and statistical contract

- Work on `feat/fault-statistics-html-report` in the existing isolated checkout.
- Preserve MIT LICENSE and Gigih Susetyo's authorship. Document fork additions separately.
- `RunResult.injectedFaults` records `{ faultType, toolName, callNumber, mode }` only after an injection is applied. Empty means known no injections; absent means unknown (legacy/replay/custom producers).
- `stats.byFault[type]` contains `injections`, `total`, `passed`, `failed`, `rate`. Total is executions exposed to that type, never individual injections. Repeated injections do not weight a run more heavily.
- A run with multiple types contributes once to each; groups overlap and do not establish causality. Untriggered plans, policy denials and ordinary tool errors are excluded.
- `stats.withoutFault` reports known unexposed executions; `stats.unknownFaultRuns` counts missing provenance. Zero input yields empty groups and finite zero metrics.
- Preserve existing overall/task-level metrics and sample warnings. No new confidence claims per type.
- Add `report.html` to the default `run` output, with `--no-html` opt-out. Existing JSON/Markdown remain available. Legacy JSON can still be replayed and rendered; missing provenance is not inferred.
- HTML includes summary, fault/task tables, sample caveats, run details and attribution. Escape all variable text. No scripts, network requests, CDN, remote fonts or external assets.
- No new agent integrations or grading changes.

## Implementation

- [x] Add failing `tests/report-stats.test.mjs` covering exact arithmetic, mixed/repeated faults, absence/unknown, and actual runner behavior for before/after/untriggered/denied/failed execution.
- [x] Extend `src/report/types.ts`, `src/fault/types.ts`, `src/fault/injector.ts`, and `src/cli/runner.ts` with injection provenance; aggregate in `src/report/stats.ts`. Run the new tests.
- [x] Add failing `tests/report-output.test.mjs` for escaped output, empty/legacy reports, JSON/Markdown values, file writing and CLI output/opt-out.
- [x] Implement `src/report/html.ts`, export it, extend Markdown and CLI. Add the reporting suite to npm test and CI; include HTML among CI artifacts.
- [x] Update README and architecture/report documentation, with explicit upstream/fork ownership and statistical limits.
- [x] Run typecheck, build, all smoke/report tests, embedded suite, controls, replay. Inspect HTML in Chromium offline at desktop/mobile sizes, keyboard disclosure and empty/hostile-input states.

## Review focus

Count after-mode injections once even if the existing runner logs a subsequent synthetic error; don't record an after-mode plan when real execution fails. Keep legacy missing provenance distinct from zero. Preserve multiple-injection counts while deduplicating run membership. Escape arbitrary task names, warnings and summaries. Verify actual artifact generation and offline rendering.

## Initial evidence

Before edits: Node 24.22.1 / npm 11.9.0; typecheck/build passed; smoke 15/15; embedded 7/7; controls 21/21; replay MATCH. No AGENTS.md was found at checkout or ancestor paths. Source tree was clean.

## Final evidence

All planned checks completed; see [verification details](../../reporting-verification.md). An independent read-only review found no blockers and reran the 13 reporting tests successfully.
