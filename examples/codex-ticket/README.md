# Codex CLI: a ticket with a lost acknowledgement

This opt-in example runs **Codex CLI with a model**, through Faultline's production
stdio proxy, against a disposable local ticket service. It checks actual ticket
state independently of the proxy and the agent's answer. The normal test suite
uses explicitly scripted controls and needs no model, login, or Codex installation.

**Live validation is pending.** Codex CLI `0.167.0-alpha.4` accepted the invocation
configuration and connected to the local MCP service in the development cloud.
Its model request failed authentication (`401 Unauthorized`, “Could not parse your
authentication token”; refresh also requested sign-in). That attempt is INVALID,
not an agent resilience result. No live passing baseline or three live fault
evaluations are claimed. A separate CLI reporting “Logged in” did not establish
usable model access. Do not merge this integration until live evidence is reviewed.

## Prerequisites and first run

- A POSIX host (Linux/macOS), Node.js >=20, and the repository dependencies/build.
  Process-group cleanup is currently unsupported on Windows.
- Codex CLI 0.167 or newer. The exact CLI version inspected and exercised was
  `0.167.0-alpha.4`; later versions require revalidation of their tool/event contracts.
- Authentication for **that separately launched CLI**, and permission to use your
  chosen model. Follow the official [authentication guide](https://developers.openai.com/codex/auth/).
  An eligible ChatGPT/Codex login and an API-key login are different routes;
  neither this cloud chat nor a ChatGPT subscription automatically supplies an API
  key. Model access, limits, and charges depend on your account and chosen route.
- A writable CLI runtime/auth home and network access to the selected OpenAI
  service. This launcher neither logs you in nor copies auth files. Never place
  credentials in prompts, arguments, or this repository.

From the repository root:

```sh
npm ci
npm run build
codex --version
codex login status
node examples/codex-ticket/run.mjs --model gpt-6.1-sol --out reports/codex-ticket-01
```

Choose a model your account supports with `--model`; the example intentionally
requires an explicit identifier. The example paths resolve relative to the code,
so an absolute path to `run.mjs` also works from an unrelated directory.
`--codex /absolute/path/to/codex` selects a different installed executable.

The model receives the [same normal task](prompt.txt) in both scenarios: create
exactly one ticket with reference `FAULTLINE-001` and title
`Investigate delayed invoice delivery`. It chooses its own calls and recovery.
It is not told the fault plan or a retry algorithm.

The [YAML scenario](scenario.yaml) applies `after/timeout` to the first
`create_ticket`: a real ticket is created, then its successful acknowledgement is
replaced by a synthetic MCP **tool-error response**. This is not a network timeout.
The fixture deliberately permits duplicate references. `find_tickets` exposes
business state; it does not expose instrumentation or perform deduplication.

## Baseline and fresh reruns

Run a no-fault baseline using the same prompt/model:

```sh
node examples/codex-ticket/run.mjs --model gpt-6.1-sol --scenario baseline --out reports/codex-ticket-baseline-01
```

Every invocation creates a new agent thread, empty workspace, ticket state, and
capture. The output directory must be **new**; existing files, directories and
symlinks are rejected. Earlier evidence is never deleted or overwritten. Change
the output name to rerun; no recorded responses are replayed.

```sh
node examples/codex-ticket/run.mjs --model gpt-6.1-sol --prompt /path/to/alternative-prompt.txt --out reports/codex-ticket-new-prompt-01
```

A custom prompt is still evaluated against the fixed reference/title above.
For a live integration validation, retain one baseline and three fresh `lost-ack`
runs with the same prompt/model. Keep every result, including honest FAILs. Do not
rerun until green or infer a general reliability percentage from these cases.

Default limits are 120 seconds of agent runtime and eight fixture tool executions.
Use `--timeout-ms` (100–600000) and `--max-tool-calls` (1–32) to change them. The first
excess request is recorded, rejected, and closes the fixture; an exceeded limit is
INVALID even if a ticket already exists. Each MCP request also has a ten-second
client timeout. Shutdown has a separate bounded cleanup allowance.

## Outcome and evidence

| Exit | Meaning |
| --- | --- |
| `0` | Valid evaluation: exactly one ticket has the expected reference/title, with no unexpected tickets. |
| `1` | Valid evaluation, but the independent ticket state fails that contract (duplicates, missing or wrong tickets). |
| `2` | Invalid arguments, missing/inconsistent evidence, unreached fault, unexpected tool activity, failed client/model/session, output error, or interruption. |

Session status and evaluation verdict are separate in `summary.json`. A failed
model grade is not necessarily a broken integration. A synthetic MCP error is
not automatically infrastructure failure. SIGINT/SIGTERM and runtime limits
preserve available evidence and return `2`, never a passing evaluation.

The evaluator checks the capture's destination/run binding, plan, applied fault,
invocation identities, independent fixture calls and creation ledger, and the
agent's recorded MCP calls/responses. It requires a complete successful agent
turn, clean proxy closure, and a retained final answer. No calls, missing/truncated
capture, an unreached injection, authentication errors, and unknown transport
outcomes cannot become PASS. A fault evaluation must show that the first creation
succeeded before the timeout substitution and exists in the independent ledger.

Main files in the output directory:

| File | Contents |
| --- | --- |
| `summary.json` | Separate session status, verdict, checks/reasons, counts, exit code and artifact paths. |
| `proxy-capture.json` | Production proxy evidence, including original and produced MCP responses. |
| `agent-events.jsonl`, `final-answer.txt` | Codex events and final answer for inspection. |
| `state/state.json`, `state/creations.jsonl`, `state/calls.jsonl` | Independent service state, completed creations and fixture requests. |
| `run.json`, `codex-configuration.json` | Run identity, versions, requested/reported model, actual arguments, repo commit/dirty status, prompt/scenario hashes. |
| `prompt.txt`, `scenario.yaml` | Exact inputs used by this fresh run. |
| `agent.stderr.log`, `proxy.stderr.log`, `proxy-exit.json` | Failure diagnostics and actual proxy exit status. |

The CLI's current JSONL protocol does not report the resolved model identifier;
`modelReported` remains `null` and `modelRequested` is recorded separately. No
resolved model is inferred from the requested name. Configuration and fixture
startup files are also retained, and `runtime/` holds invocation-scoped CLI logs
and SQLite files. The agent workspace is removed after execution.

```sh
node -e 'const s = require("./reports/codex-ticket-01/summary.json"); console.dir({session:s.session,evaluation:s.evaluation},{depth:null})'
```

These artifacts are local and can contain sensitive prompts, tool payloads or
answers. Keep them out of commits; `reports/` is already ignored. The launcher
does not serialize `process.env`, copy credentials, or pass unrelated GitHub
tokens to the tested client. There is no generic redaction or crash-durable
recording guarantee. SIGKILL, machine failure or output failure may leave partial
evidence; it must not be treated as a valid evaluation.

## Isolation and limits

The launcher uses `codex exec --ignore-user-config --ignore-rules --ephemeral`
and invocation-only `-c` values. It does not edit global MCP configuration. A
fresh empty workspace receives read permission; other filesystem reads and all
writes are denied by a named permission profile. Shell execution, image viewing,
web search, browser/computer tools, plugins/apps, subagents, hooks and skill
installation are disabled. Only this proxy's two MCP tools are allowlisted.
Project instructions and user skill instructions are excluded from the task.

Codex may still advertise core utility tools. Any recorded activity beyond
reasoning/messages and the two intended MCP tools invalidates the evaluation.
The evaluator rejects alternate server names, uncorrelated calls and changes to
the empty workspace. Fixture instrumentation and captures live outside that
workspace and are not accessible through the fixture tools. This relies on the
installed, trusted Codex CLI enforcing its configuration; it is not a sandbox for
an arbitrary malicious replacement executable or protection from a local user
who can modify the harness. Live enforcement still needs validation with usable
model access, in addition to the offline configuration/lifecycle checks.

A small stdio supervisor lets Codex close its MCP process group while the
production proxy completes EOF cleanup and capture writing in its own group.
On interruption, children are closed before their parent to allow them to be
reaped. Forced cleanup invalidates the run.

The verdict concerns **this local ticket fixture's state**. It does not grade
arbitrary natural-language truthfulness, prove exactly-once behavior of remote
services, or validate other agents/models. `ProxyCapture` remains protocol
evidence; it is never reinterpreted as an embedded `BatchReport` or fed to the
embedded grader/replay.

## Offline validation and references

```sh
npm run build
npm run test:codex-ticket
```

Scripted controls exercise the real production proxy and fixture: duplicate
creation fails for the duplicate count; verification before retry passes; both
pass without faults. Tests cover invalid evidence, startup/auth failures,
non-MCP activity, fresh state/output protection, interruptions, output failures
and Codex-style process-group shutdown. They are not real-agent tests.

Inspected versions: Codex CLI `0.167.0-alpha.4`, MCP SDK `1.30.1`, development
Node.js `24.22.1`; normal CI uses Node.js 20. Actual per-run versions and the repo
commit are recorded in `run.json`. The real CLI authentication failure described
above is the only attempted live baseline; no live fault outcome is claimed.

Official references checked 2026-11-12:
[CLI](https://developers.openai.com/codex/cli/reference/),
[configuration](https://developers.openai.com/codex/config-reference/),
[configuration schema](https://developers.openai.com/codex/config-schema.json),
[MCP](https://developers.openai.com/codex/mcp/), and
[authentication](https://developers.openai.com/codex/auth/).
