<p align="center">
  <img src="./docs/logo.png" alt="MCP-Faultline" width="140" />
</p>

<h1 align="center">MCP-Faultline</h1>

<p align="center"><em>Break your MCP agent. Then prove it recovered.</em></p>

<p align="center">
  <a href="https://github.com/gigihsusetyo/mcp-faultline/actions/workflows/ci.yml"><img src="https://github.com/gigihsusetyo/mcp-faultline/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://www.agensi.io/skills/mcp-faultline"><img src="https://img.shields.io/badge/Agensi.io-available-blue" alt="Agensi.io" /></a>
</p>

---

Faultline injects controlled failures into an MCP agent's tool calls, records the trajectory, and grades whether the agent recovered. With evidence, not just pass/fail.

**About this fork:** [olinkluzz1v/mcp-faultline](https://github.com/olinkluzz1v/mcp-faultline) extends the original [MCP-Faultline by Gigih Susetyo](https://github.com/gigihsusetyo/mcp-faultline). Our first additions are statistics by actually injected fault type and a standalone offline HTML report. The original MIT license and copyright are preserved. See [fork additions and report semantics](docs/reporting.md).

**Status:** MVP. Working, tested, but early. Read [Limitations](#limitations) before trusting it for anything serious.

---

## Why

Most agent benchmarks measure **capability**: can the agent solve the task?

Faultline measures **resilience**. When a tool times out, returns malformed data, or lies, does the agent detect it, recover, or quietly break?

Two agents can both "pass" a task and behave completely differently under failure. Faultline is built to tell them apart.

---

## Quickstart

Requires Node.js >= 20.

```bash
git clone https://github.com/olinkluzz1v/mcp-faultline.git
cd mcp-faultline
npm ci
npm run build
```

### Guided local demo: a lost acknowledgement

```bash
node dist/cli.js demo --out reports/demo-lost-acknowledgement
```

This **scripted local filesystem demo** needs no API key, Docker, or external
service. The first `write_file` completes, but an `after` fault replaces its
acknowledgement with a timeout. Two bounded policies react to the results visible
to the agent, using the same [task](tasks/demo/lost-acknowledgement.yaml),
permissions, fault plan, and grading rules in separate fresh workspaces:

| Policy | Response to the timeout | Completed writes | Actual grade |
| --- | --- | --- | --- |
| Naive retry | Retry the write once | 2 | **FAIL**: `file_written_exactly_once` |
| Verify before retry | Read the file and confirm its intended contents | 1 | **PASS** |

Both leave the intended contents on disk. The difference is the duplicate
completed write, checked by the existing integrity grader. The verification
policy stops without another write if it cannot confirm the contents. Neither
policy sees the injection metadata or knows whether the timed-out write ran.

The command prints expected and actual grades, observed completed-write counts,
injection evidence, and paths to JSON, Markdown, and offline HTML reports:

```text
reports/demo-lost-acknowledgement/naive/report.{json,md,html}
reports/demo-lost-acknowledgement/verify-before-retry/report.{json,md,html}
```

Open either `report.html` directly in a browser. Reports retain the actual grades;
**“Demo verified both expected outcomes” does not mean both agents passed.** The
naive agent remains FAIL, specifically because of the duplicate write; its state,
policy, witness, and recovery checks pass.

Demo exit codes (scoped to `demo`):

- **0:** both expected outcomes, the applied after-timeout, completed writes, and
  required grading evidence were verified.
- **1:** an expectation or its evidence did not match. Reports are retained for
  diagnosis. An arbitrary FAIL or a missing injection cannot verify the demo.
- **2:** configuration, harness, or report-writing failure. Incomplete output
  created by this invocation is removed where possible. A handled SIGINT/SIGTERM
  during execution also returns 2, never a verified demonstration.

`--out` is required and must name a **new directory**; existing files, directories,
and symlinks are rejected without overwriting reports. Choose a new name to rerun.
Parent directories are created as needed. The bundled fixture is resolved relative
to the installed code, so the CLI also works from an unrelated working directory
when invoked by its absolute path. Temporary agent workspaces are cleaned up;
reports retain the trajectory, execution evidence, and actual file assertions.

This demo does not verify a real LLM integration or establish exactly-once behavior
for arbitrary external services. The evidence concerns this controlled local file
executor and these two scripted policies.

### Opt-in Codex CLI ticket example

With a separately authenticated Codex CLI and access to the chosen model:

```bash
node examples/codex-ticket/run.mjs --model gpt-6.1-sol --out reports/codex-ticket-01
```

This example connects Codex to a disposable ticket service through the production
proxy. The first ticket is created before its acknowledgement becomes a synthetic
MCP timeout error. Independent service state determines PASS/FAIL; captures, agent
events, configuration and the final answer are retained. Each rerun requires a
fresh output directory. `--scenario baseline` runs the same task without a fault.
Exit codes are `0` for a valid PASS, `1` for a valid FAIL, and `2` for invalid or
incomplete evidence, infrastructure errors or interruptions.

**Live model validation is pending:** the inspected Codex CLI could connect to MCP
but its model authentication failed. Normal CI covers scripted controls only and
requires no model credentials. See the [example guide](examples/codex-ticket/README.md)
for prerequisites, isolation, exact versions, outputs and fresh prompt/model reruns.

### Run the suite and convert reports

```bash
# Run the suite with the embedded agent
node dist/cli.js run

# Oracle validation: good agents vs bad agents
node dist/cli.js negative-controls

# Replay the most recent run
node dist/cli.js replay reports/report.json
```

The `run` command writes `reports/report.json`, `reports/report.md`, and `reports/report.html`. Open the HTML file directly in a browser; it needs no server or internet connection. Use `--out <directory>` to choose the destination or `--no-html` to skip HTML generation.

All three formats include results by injected fault type. A run counts once per type even if that fault is injected repeatedly; injection counts are shown separately. Runs with several types appear in several groups. [Read the counting rules and limitations](docs/reporting.md#counting-rules) before comparing percentages.

### Use `run` as a CI check

```bash
npm ci
npm run build
node dist/cli.js run --tasks tasks --runs 1 --out reports/ci
```

Let the CI shell use the command's exit status; upload the report directory even
when the check fails. `run` uses these exit codes:

| Code | Meaning |
| --- | --- |
| `0` | At least one evaluation completed, every `grade.passed` is true, and all requested reports were written. |
| `1` | At least one grade failed. The normal batch finishes, including all repetitions, and its actual grades are saved in the reports. |
| `2` | Invalid arguments, empty/missing task directory, invalid task file, or an unexpected harness, sandbox, or report-writing failure. This takes precedence over failed grades. |

**Changed behavior:** failed grades previously printed a summary and exited `0`;
they now fail the CI step with `1`. Grading rules and recorded grades are unchanged.
Injected tool failures and legitimate safe aborts are evaluated by the grader;
they do not automatically imply an infrastructure error. An unexpected agent
exception or sandbox cleanup failure is an infrastructure error.

`--runs` requires whole-number decimal digits representing a positive safe integer
from `1` through `9007199254740991`. Zero, negative, fractional, nonnumeric,
infinite, and unsafe values are rejected before loading tasks or writing output.
`run --help` exits `0` without evaluating tasks or creating reports.

SIGINT/SIGTERM normally exit `130`/`143` after registered sandbox cleanup. A failed
grade already detected remains `1`; an infrastructure/output error remains `2`,
including one detected while signal cleanup is pending. No interrupted operation
is reported as success. Interrupted/error output can be incomplete; failure cleanup
does not delete existing reports. Normal runs retain their existing overwrite
behavior, so use a separate `--out` directory to preserve an earlier batch.
The [demo](#guided-local-demo-a-lost-acknowledgement) keeps its separate `0/1/2`
contract, where a correctly failing negative control is an expected outcome.

### Convert a saved report

Convert a saved batch to offline HTML without running agents or tasks again:

```bash
node dist/cli.js report saved-report.json --out report.html
# Explicitly replace an existing output file:
node dist/cli.js report saved-report.json --out report.html --force
```

The command validates the batch, preserves its grades and metadata, and rebuilds
all statistics from its runs. Legacy runs without injection metadata remain
unknown. No `tasks` directory is needed. `--out` is required, its parent directory
must exist, and the input is never overwritten, even with `--force`. Invalid
input and write failures produce a message and a nonzero exit code. See
[saved-report conversion](docs/reporting.md#convert-a-saved-report) for details.

---

## A failure the grader actually caught

This is from the idempotency test. A write succeeds on disk, but the response is replaced by a timeout. The agent retries and writes again.

```
$ npm run test:idempotency-smoke
...
✅ integrity assertion fails
   File written 2 times (expected exactly 1): output.txt
✅ file was actually written (side-effect happened)

Total: 5/5 passed
```

A sequence-based grader would see "two write calls, no error". A state-based grader sees two side effects on a file that should have one. That is the difference.

---

## How it works

```
      Task (YAML)
          |
          v
   +--------------+
   |   Sandbox    |   isolated temp folder
   +--------------+
          |
          v
   +--------------+       +---------------+
   |    Agent     | <---> |  Fault Layer  |   inject / forward
   +--------------+       +---------------+
          |                       |
          |                       v
          |              +------------------+
          |              |  Real MCP Server |
          |              +------------------+
          v
   +--------------+
   |  Trajectory  |   every call, every result
   +--------------+
          |
          v
   +--------------+
   |   Grader     |   5 layers
   +--------------+
          |
          v
      Report (JSON / Markdown / HTML)
```

The agent can run embedded (in-process) or as an external process behind a stdio proxy. The proxy lets Faultline sit between a real agent like Cline and a real MCP server.

More detail in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Commands

| Command | Description |
|---|---|
| `demo --out <directory>` | Guided no-key lost-acknowledgement demo with two scripted policies |
| `run` | Run the task suite with the embedded agent |
| `list` | List available task YAML files |
| `negative-controls` | Oracle validation: 5 agents × tasks, 21 entries |
| `proxy [--capture <file.json>]` | stdio proxy with optional JSON session evidence |
| `replay` | Re-run an agent against a recorded trajectory |
| `report` | Convert saved BatchReport JSON to offline HTML without re-execution |

The stdio proxy preserves upstream MCP tool errors and applies `after` faults
only to observed successful responses. Its SDK integration tests independently
verify fixture writes, response forwarding, concurrent call identities, and
disconnect uncertainty. See [proxy protocol and evidence](docs/proxy.md) for the
tested behavior, API compatibility notes, and remaining limits.

Use `--capture reports/proxy-session.json` with an existing parent directory and
a fresh filename to retain calls, original upstream responses, exact produced
responses, applied faults, and termination information. EOF finalizes the
capture; signals and infrastructure/output failures exit nonzero. Captures are
local protocol evidence, without agent grades or remote side-effect guarantees.
Payloads and command arguments may contain sensitive data. See the
[copyable SDK example and capture contract](docs/proxy.md#capture-a-session).

---

## Five-layer grading

Every run is graded on five layers. Only the first four affect pass/fail.

| Layer | Question |
|---|---|
| **Outcome** | Did the final workspace match the task? |
| **Safety** | Did the agent stay within allowed tools and constraints? |
| **Recovery** | What strategy did the agent use, and did it work? |
| **Integrity** | What side effects actually happened? |
| **Efficiency** | How many calls, retries, duplicates? (informational) |

Recovery is two-dimensional: a strategy (retry, fallback, abort, ...) and an outcome (recovered, looped, false-recovery, ...).

---

## Fault taxonomy

18 fault types across 6 categories.

| Category | Faults |
|---|---|
| Transport | `timeout`, `latency`, `disconnect`, `rate_limit` |
| Protocol | `malformed_response`, `invalid_schema`, `missing_field` |
| Data | `empty`, `partial_result`, `stale`, `contradictory`, `wrong_value` |
| Authorization | `auth_expired`, `forbidden` |
| Temporal | `delayed`, `out_of_order`, `replayed` |
| Systemic | `burst_failure`, `server_outage`, `cascading_failure` |

Each fault can be applied in one of two modes:

- `mode: instead` replaces the tool call. No side effect happens.
- `mode: after` runs the tool first, then replaces the response. Side effect happens.

`mode: after` is how idempotency violations are modelled: a write succeeds, the agent sees a timeout, retries, and writes twice.

---

## Comparison

| Tool | Focus | Grades recovery? | State-aware? | Replayable? |
|---|---|---|---|---|
| Benchmarks (MCP-Bench, MCP-Atlas, ...) | Capability | No | No | No |
| Chaos tools (mcp-chaos, ...) | Injection + SLI metrics | No | No | No |
| Eval frameworks (mcp-eval, ...) | Pass/fail correctness | No | Partially | No |
| **MCP-Faultline** | Resilience under fault | Yes | Yes | Yes |

The bench measures whether the agent can solve the task. The chaos tool injects faults and measures service-level metrics. Faultline injects faults, then grades what the agent did about them.

---

## Limitations

Honest list. These are the things that are not done yet.

- **Mode A only.** We grade what the agent attempted, not what the consequences were. Mode B is future work.
- **File-based side effects only.** Network calls, emails, git commits are not tracked.
- **Live model validation is pending.** The [Codex ticket example](examples/codex-ticket/README.md) provides an opt-in external-agent workflow and independent local state checks. Its deterministic CI controls are scripted; the actual model attempt was blocked by authentication. No live-model compatibility or general resilience claim is established.
- **No LLM judge.** Everything is deterministic. No model in the grading loop.
- **Fault statistics are observational.** Mixed-fault runs contribute to multiple groups; the report does not identify which fault caused a failure. Older runs without injection metadata are marked as unknown.
- **Execution is not proof of a side effect.** Embedded records distinguish an invoked executor (`executed`) from successful completion (`executionSucceeded`). Failed I/O may leave partial effects; replay cannot reconstruct those. Proxy records distinguish forwarding from observed responses; remote execution remains unknown without independent state. A synthetic timeout response does not prove a real transport timeout. See [proxy evidence](docs/proxy.md#remote-observations).
- **Replay is single-run.** No batch replay, no agent-vs-agent comparison yet.
- **Older duplicate records remain ambiguous.** Replay does not repair trajectories recorded by the former `after` duplication bug. Re-run the task for a fresh trajectory; saved-report conversion keeps historical evidence and grades unchanged.

---

## Development

```bash
npm run build           # tsc
npm run dev             # tsc --watch

npm run test:proxy-smoke        # proxy intercepts and injects faults
npm run test:proxy              # MCP SDK stdio integration and independent write evidence
npm run test:integrity-smoke    # integrity layer catches double-writes
npm run test:idempotency-smoke  # mode: after produces a real double-write
npm run test:agent              # structured tool results, execution evidence and replay
npm run test:report             # fault statistics, provenance, output and CLI
npm run test:demo               # local recovery demo, evidence and CLI exit behavior
npm run test:run                # batch exit codes, validation and interruption
npm run test:codex-ticket       # offline scripted ticket controls; no Codex/model needed
npm test                        # smoke, agent, reporting, demo and run checks (build first)
```

Full suite (build, run, oracle, replay):

```bash
npm run test:all
```

---

## Design notes

A few decisions worth explaining.

**State-based, not sequence-based.** A sequence checker asks "did the agent call tool X before tool Y". A state checker asks "does the final workspace match the task". The second one lets multiple valid solutions pass.

**Faults look like normal responses.** Data-shape faults (`stale`, `empty`, `wrong_value`) return `{ status: "success", data: { _fault: {...}, data } }`. The agent cannot tell from the wire format that anything is wrong. Only the grader sees the `_fault` marker.

**Security is audited, not blocked.** The stdio proxy spawns subprocesses. Rather than blocking unknown commands, we warn and record. Every spawn is logged in the trajectory. The allowlist defaults to `node`, `npx`, `python`, `python3`.

**Replay is real re-execution.** Replaying a trajectory does not just dump the old results. Write tools run again on a fresh sandbox. Read tools return recorded data. The end state matches.

**Embedded results preserve their status.** The next agent step receives the
complete structured result, including timeout, malformed response, error code,
or policy denial details. Synthetic successes return their intended data.
`AgentTool.execute()` keeps its data-or-throw API; ordinary payloads with a
`status` field remain data. See [the result and compatibility contract](ARCHITECTURE.md#tool-results-and-execution-evidence).

---

## Requirements

- Node.js >= 20
- No Docker. No external services. No API keys for the embedded suite.

Tested on macOS, Linux, and Windows 10.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Author

**Gigih Susetyo**

Available as an agent skill on [Agensi.io](https://www.agensi.io/skills/mcp-faultline).

Fork reporting additions are maintained in [olinkluzz1v/mcp-faultline](https://github.com/olinkluzz1v/mcp-faultline); they do not replace or imply authorship of the original project.
