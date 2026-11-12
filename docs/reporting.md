# Reporting additions in this fork

MCP-Faultline was created by **Gigih Susetyo** in
[gigihsusetyo/mcp-faultline](https://github.com/gigihsusetyo/mcp-faultline).
The original [MIT license and copyright](../LICENSE) remain unchanged.
[olinkluzz1v/mcp-faultline](https://github.com/olinkluzz1v/mcp-faultline)
adds the reporting features described here. No new agent integration is included.

## Generate a report

```bash
npm run build
node dist/cli.js run --out reports
# Optional: repeated executions, or skip HTML
node dist/cli.js run --runs 3 --out reports/repeated
node dist/cli.js run --no-html --out reports/text
```

The default output is `report.json`, `report.md`, and `report.html` in the
chosen directory. The HTML can be copied as one file and opened with a `file:`
URL. It contains its own CSS, uses system fonts and native `<details>` controls,
and loads no scripts, images, remote styles or data. Its GitHub links are optional
navigation, not dependencies. All variable HTML text is escaped.

The report presents overall results, results by fault type, task-level results,
sample limitations and expandable run details. Percentages always appear with
their sample counts. Narrow screens can scroll each table horizontally; all
essential information is available without hovering or enabling JavaScript.

## Convert a saved report

```bash
node dist/cli.js report saved-report.json --out report.html
node dist/cli.js report saved-report.json --out report.html --force
```

`report` reads an existing **BatchReport** JSON file and writes the same standalone
HTML format as `run`. It does not load task YAML, execute agents or tools, replay
trajectories, or grade results again. It works from a directory without `tasks`;
input and output paths are resolved relative to the current directory.

Before rendering, the command validates the `meta`, `runs`, and `stats` batch
envelope and the nested run fields, including grades, trajectories, and any
injection records. Metadata includes a valid numeric timestamp, nonnegative
durations, and integer task/run counts. Field types are not coerced and missing
grades are not invented. Unknown extra metadata is retained. Individual
`RunResult` objects and raw proxy records are not supported by this command.

All aggregate statistics are recalculated with `computeStats` from the validated
runs. The saved `stats` must be an object, but its contents are ignored, so stale
or incomplete summaries cannot determine the displayed results. Original grades
and metadata, including the generation timestamp, are preserved. Older batches
without `injectedFaults` are supported: missing provenance remains **unknown**,
while an explicit empty array means known zero injections.

`--out` is required and names a file, not a directory. Its parent directory must
already exist. Existing output is preserved unless `--force` is given. Even
with `--force`, the output cannot be the input or a hard-link alias of it;
output symlinks (including dangling links) are rejected. Input symlinks can be
read normally. Rendering completes in a temporary file before the output is
installed; concurrent conversions cannot overwrite an output without `--force`.
Forced replacement replaces the file rather than truncating a linked target.

A missing/unreadable input, malformed JSON, invalid batch structure, existing
output without `--force`, or a failed write produces a clear error and a nonzero
exit code. Validation happens before writing, so malformed input cannot replace
an existing output. The source file is never modified. HTML escaping and the
no-script, no-external-assets offline contract are unchanged.

## Counting rules

The embedded runner records `RunResult.injectedFaults`, an array of
`{ faultType, toolName, callNumber, mode }` observations. `callNumber` is one-based
per tool. An empty array means zero applied injections; an absent field means
provenance is unknown. The runner records:

- `instead` when a synthetic result replaces real execution;
- `after` only after real execution succeeds and its response is replaced.

Unreached plans, policy-denied calls and natural tool errors do not count.
The fault type comes from the matching injection decision, not from the error
message, result status, task name or a later copy of the task YAML. Data faults
can have a `success` result status and still count as injections.

Each `stats.byFault[type]` has:

| Field | Meaning |
|---|---|
| `injections` | Every recorded injection of this type |
| `total` | Executions with at least one injection of this type |
| `passed` / `failed` | Whole-run grades among those executions |
| `rate` | `passed / total`, as a fraction from 0 to 1 |

For example, a passing run with two timeouts and a failing run with one timeout
produce **3 injections, 2 runs, 1 passed, 1 failed, 50%**. Repeated injections do
not give an execution extra weight. A run containing both `timeout` and `empty`
contributes once to each group. Groups overlap; summing their run counts or
interpreting a failed group as causal attribution is incorrect.

`stats.withoutFault` has `total`, `passed`, `failed`, and `rate` for runs with a
known empty injection array. These are unexposed observations, not a randomized
control group. `stats.unknownFaultRuns` counts runs with absent provenance and
excludes them from both fault and no-injection groups. Empty batches have no
fault groups and finite zero numeric metrics; HTML shows `N/A` for absent rates.

Overall/task statistics and grading are unchanged. Repeated deterministic runs
are not independent samples. Per-type rates are descriptive; no per-type
confidence intervals or causal claims are added. Existing sample warnings and
the distinction between run-level and task-level statistics remain visible.

## API and compatibility

```ts
import { computeStats, toHtml, writeHtml } from 'mcp-faultline';

const report = { meta, runs, stats: computeStats(runs) };
const html = toHtml(report);
await writeHtml(report, 'reports/report.html');
```

Like `writeJson` and `writeMarkdown`, `writeHtml` expects the parent directory to
exist and propagates filesystem errors. The CLI creates the output directory.

JSON gains additive fields. Old reports still work with replay; HTML/Markdown
renderers derive the fault breakdown from run metadata when stored statistics
lack it. They never guess provenance for older runs. Replay currently returns
no injection metadata, so its results are also treated as unknown if aggregated.
The separate raw proxy trajectory format is unchanged.

TypeScript consumers constructing `BatchStats` manually must supply the new
breakdown fields or use `computeStats`. Custom `FaultInjector` implementations
must now include `faultType` on non-`none` injection decisions. No changes to
task YAML or runtime dependencies are required.

## Verification

```bash
npm run build
npm test
npm run test:all
./node_modules/.bin/tsc --noEmit
```

`npm run test:report` uses Node's built-in test runner and tests hand-calculated
rates, repeated and mixed fault types, empty/legacy data, actual runner injection
boundaries, escaping, output files and the CLI opt-out. Saved-report CLI tests
also cover nested validation, stale statistics, conversion without task files,
input aliases, explicit overwrite permission, and concurrent output creation.
CI runs this suite and
uploads HTML with JSON/Markdown. See the implementation plan for the initial
baseline; final validation evidence is recorded alongside the change.
