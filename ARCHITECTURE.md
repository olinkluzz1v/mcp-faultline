# Architecture

This document explains how MCP-Faultline is put together. It is for people who want to extend it, review it, or understand why certain decisions were made.

If you just want to use it, the [README](./README.md) is enough.

---

## Overview

Faultline runs an MCP agent against a task, injects controlled failures into its tool calls, records what happened, and grades the result on five layers.

The core loop is:

```
Task ──► Sandbox ──► Agent ──► Tools ──► Trajectory ──► Grader ──► Report
                        │
                        └──► Fault Injector
```

The agent is treated as a black box. Faultline does not run the agent's loop. It provides tools, observes calls, and grades the outcome. This is what makes it agent-agnostic.

---

## Layers

There are six top-level layers. Each one is independent and has its own directory under `src/`.

| Layer | Directory | Responsibility |
|---|---|---|
| Task | `src/task/` | Parse, validate, load YAML specs |
| Sandbox | `src/sandbox/` | Isolated workspace, snapshots, cleanup |
| MCP | `src/mcp/` | Trajectory recording, event log, types |
| Agent | `src/agent/` | Agent interface, embedded implementation |
| Fault | `src/fault/` | Fault definitions, registry, injector |
| Grader | `src/grader/` | 5-layer grading |
| Report | `src/report/` | Stats, JSON, Markdown and standalone HTML output |
| Proxy | `src/proxy/` | stdio proxy for external agents |
| Replay | `src/replay/` | Re-run from recorded trajectory |
| CLI | `src/cli/` | Command line entry points |

Dependencies flow downward. Task does not depend on Grader. Grader depends on Task types only.

---

## Data flow

A single run (`node dist/cli.js run`) looks like this:

```
1. Load task YAML       → Task object
2. Create sandbox       → temp folder
3. Seed workspace       → initial files per task
4. Snapshot before      → hash all files
5. Build tools          → policy gate + fault injector + executor
6. Run agent            → step-by-step, tools called
7. Snapshot after       → hash all files
8. Grade                → 5 layers
9. Report               → JSON + Markdown
10. Cleanup             → delete temp folder
```

Between step 5 and 6, every tool call goes through a wrapper that does three things in order:

1. Records the attempt.
2. Checks policy (allowed or forbidden).
3. Applies fault injection, then either executes the real tool or returns a synthetic result.

The wrapper is the only place policy and faults touch the run. The agent never knows.

---

## Key modules

### `src/fault/registry.ts`

Single source of truth for all fault types. Each fault has a category, a description, and a `build` function that returns the synthetic result.

Adding a new fault means adding one entry to `DEFINITIONS`. Nothing else changes. Previously, this required touching three switch statements in three files, which is why the registry exists.

### `src/fault/types.ts`

Defines `InjectionDecision`, a three-way discriminated union:

```typescript
type InjectionDecision =
  | { mode: 'none' }
  | { mode: 'instead'; result: ToolCallResult }
  | { mode: 'after'; result: ToolCallResult };
```

`none` means no fault. `instead` means replace the call. `after` means run the call first, then replace the response. The caller is responsible for honoring the mode.

### `src/grader/`

Five modules, one per layer, plus a shared `types.ts` and an orchestrator (`grader.ts`).

- `state.ts`: end-state assertions (`file_exists`, `file_valid_json`, ...)
- `policy.ts`: trajectory assertions (`no_forbidden_tool_called`, `max_tool_calls`, ...)
- `recovery.ts`: 2D classification (strategy + outcome)
- `integrity.ts`: side-effect assertions (`file_written_exactly_once`, ...)
- `efficiency.ts`: informational metrics
- `witness.ts`: causal evidence (`state_delta`, `content_match`)

The orchestrator runs them in order, then combines the results. Only the first four affect `passed`. Efficiency is metadata.

### `src/proxy/`

The stdio proxy sits between an external MCP client (Cline, Claude Code, ...) and a real MCP server. It plays two roles at once:

- Server facing the agent (listens on its own stdin/stdout).
- Client facing the real server (spawns a subprocess).

`bridge.ts` wires the two sides together and consults `fault-runtime.ts` before every `tools/call`. The runtime returns a decision, and the bridge either short-circuits (`instead`) or forwards and replaces (`after`).

`after` requires an observed successful MCP tool response. Upstream `isError`
responses pass through unchanged and do not count as injections. The bridge
keeps invocation identity independent of completion order. `response.ts` adapts
synthetic registry payloads to SDK response shapes without exposing private
injection bookkeeping. See [proxy protocol and evidence](docs/proxy.md) for
remote execution uncertainty and the additive `executed: "unknown"` contract.

### `src/replay/replay.ts`

Replays a recorded trajectory. For each tool call the agent makes during replay, the tool wrapper looks up the corresponding source call in the recorded trajectory.

Read-only tools return the recorded data. Write tools execute on a fresh sandbox so the end state matches. If the agent makes a call that does not exist in the source, replay aborts with an error. That is a signal, not a bug.

Matching uses `(toolName, args, callNumber)`. `callNumber` is 1-based per tool, so identical repeated calls map cleanly.

---

## Design decisions

A few that are worth writing down.

### State-based grading, not sequence-based

Most test harnesses check call sequence: "tool A must be called before tool B". This is brittle. It locks the agent into one valid path.

Faultline checks the end state. If the agent finds a different way to produce the right workspace, it passes. This is the whole point of the thesis.

### Faults look like normal responses

Data-shape faults (`stale`, `empty`, `wrong_value`) return a success status with a `_fault` marker in the payload:

```json
{ "status": "success", "data": { "_fault": { "kind": "stale" }, "data": {...} } }
```

This is the registry's internal representation. The stdio proxy exposes the
inner application payload as MCP content and structured content, keeping this
private marker in its records. This does not imply that a synthetic payload is
indistinguishable from real application data.

### Tool results and execution evidence

Some faults run the tool first (`mode: after`). Some do not (`mode: instead`). Some policies deny the call outright. The trajectory needs to distinguish these.

`executed: true` means the real executor was invoked, including attempts that
throw. `executed: false` means policy or injection short-circuited the call.
New embedded records also include `executionSucceeded`: whether the executor
completed successfully **before** the response was replaced. A successful
`write_file` execution confirms a completed write; an attempted execution alone
does not. Failed I/O can have partial effects that these flags cannot quantify.

Integrity counting and replay use completed execution evidence. For legacy
records without the new field, they retain the historical `executed` fallback.
Replay preserves source execution evidence even for reads served from recorded
data. Proxy records have a separate [remote observation contract](docs/proxy.md#remote-observations)
and must not be treated as embedded execution/side-effect evidence.

`AgentTool.execute()` still returns raw data or throws. Wrappers return the
data for every `success` result, including synthetic successes. Failures use
the exported `ToolResultError`, which carries the full typed `ToolCallResult`.
`EmbeddedAgent` recognizes that class, preserves status and associated fields
in the history passed to the next step, and treats other exceptions as `error`.
Ordinary payloads containing `status` or `result` never become control signals.
`PolicyViolationError` retains its constructor, fields, and original runner
export; it now also carries the structured policy result.

The history result has a typed status union; existing optional `data` and
`message` access remains available. Consumers that used `status === 'error'`
for all failures should explicitly handle `timeout`, `malformed`, and
`policy_violation`. Each wrapper call produces exactly one `ToolCallRecord`;
separate lifecycle events remain in the event log.

### Counter independence in the runner

The tool wrapper uses two local counters: a global one for `index`, and a per-tool one for `callNumber`.

Call identity is allocated when the wrapper is entered, before policy,
injection, or execution. Recording finishes before result delivery, so throwing
a structured failure cannot add a second record. Replay uses the same per-tool
call number and checks the arguments of that occurrence.

### Security by audit, not by block

The proxy spawns subprocesses. The MCP SDK does this without sanitization, which OX Security flagged in April 2026.

Faultline's approach: warn, do not block. A default allowlist (`node`, `npx`, `python`, `python3`) covers common cases. Anything else still runs, but the event is logged as `command_warned`. Every spawn is in the trajectory.

This is a deliberate choice. The tool is an evaluator, not a firewall. Blocking loses observability, which is worse.

### Replay re-executes, it does not just replay data

A naive replay would just dump the recorded results. That proves nothing.

Faultline's replay actually re-runs the agent and re-executes write tools on a fresh sandbox. Only the tool *responses* come from the recording. If the end state does not match, replay fails. This makes the replay a real reproducibility check.

---

## Extension points

Where to add things.

**New fault type.** Add one entry to `DEFINITIONS` in `src/fault/registry.ts`. Update the `FaultType` union to match. Nothing else.

**New grading layer.** Add a module under `src/grader/`, add a field to `GradeResult`, call it from `grader.ts`. Keep it independent.

**New agent.** Implement `AgentAdapter` from `src/agent/types.ts`. If it runs out of process, route it through the proxy.

**New task.** Drop a YAML file into `tasks/`. The schema is in `src/task/schema.ts`.

**New CLI command.** Add a file under `src/cli/`, register it in `src/cli/index.ts`.

---

## Constraints

Some are self-imposed, some are environmental.

- **TypeScript only.** No Python, no shell scripts beyond what is needed.
- **Zero cost.** No paid API keys, no cloud services.
- **Node 20+.** Required by the MCP SDK.
- **No Docker.** The sandbox is a temp folder. CI runs on bare Ubuntu.
- **Zero runtime dependencies beyond:** `@modelcontextprotocol/sdk`, `commander`, `yaml`, `zod`.

---

## Testing

Three smoke tests, reporting tests, and the oracle matrix.

| Test | What it covers |
|---|---|
| `proxy-smoke` | Proxy spawns, forwards, injects faults, shuts down |
| `integrity-smoke` | Integrity layer catches a double-write |
| `idempotency-smoke` | `mode: after` produces a real double-write |
| `test:report` | Observed fault statistics, runner provenance, escaped output and CLI artifacts |
| `test:agent` | Next-step history, one record per wrapper call, real file state, execution evidence and replay |
| `negative-controls` | 21-entry matrix: good agents pass, bad agents fail |
| `replay` | Reproduces a previous run exactly |

All of these run in CI on Ubuntu with Node 20.

---

## Known limitations

See the [Limitations](./README.md#limitations) section in the README for the user-facing list.

Failed filesystem operations may leave partial side effects. Replay reproduces
completed writes and moves, not partial effects from failed calls. Older
recordings containing duplicate call records from the former `after` wrapper
bug remain ambiguous; replay does not silently repair them. Saved-report
conversion preserves their original grades and records without re-evaluation.

---

## Further reading

- [README](./README.md): overview and usage
- Source: `src/`
