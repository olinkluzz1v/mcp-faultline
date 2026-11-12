# Codex CLI: a ticket with a lost acknowledgement

This opt-in example runs **Codex CLI with a model**, through Faultline's production
stdio proxy, against a disposable local ticket service. It checks actual ticket
state independently of the proxy and the agent's answer. The normal test suite
uses explicitly scripted controls and needs no model, login, or Codex installation.

**Local live validation completed on 2026-11-12:** one baseline and exactly three
sequential lost-ack runs were valid PASS on
`552af50aeac8dbed6e938b24299e6967beb5e0d5`, with the original prompt and
`modelRequested: gpt-6.1-sol`. The CLI supplies no reported model identifier;
`modelReported` remains null. These four observations establish this integration's
observed behavior, not a general reliability rate. PR #10 remains open for review.

## Prerequisites and first run

- A POSIX host (Linux/macOS), Node.js >=20, and the repository dependencies/build.
  Process-group cleanup is currently unsupported on Windows.
- Codex CLI 0.167 or newer. The locally validated version is
  `0.167.2`; other versions require revalidation of their tool/event contracts.
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
who can modify the harness. The four local live runs used only the intended MCP tools; they do not prove
resistance to every possible sandbox bypass.

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

Validated environment: Codex CLI `0.167.2`, Node.js `24.22.3`, npm `12.2.2`,
MCP SDK `1.32.2`, Zod `4.6.7`, with ChatGPT subscription login and no API keys.
SDK and Zod direct minimums are `^1.32.2` and `^4.6.7`. The dependency fix also
updated @hono/node-server 2.1.8, body-parser 2.4.0, fast-uri 3.1.9, hono 4.13.18,
ip-address 10.7.6 and qs 6.17.1; lockfile tarballs use the official npm registry.
The earlier dependency validation passed plain npm ci and audit including dev
dependencies with zero findings; these are historical checks, not repeated here.

Local checks for the live-tested code passed: typecheck, build, npm test (including
27 ticket tests and strict runtime-error/missing-call/unauthorized-activity
rejections), test:all (7/7 runs, 21/21 controls, replay MATCH), and diff formatting.
GitHub CI is separate from these local checks; consult PR #10's final-head checks.
The subsequent documentation-only commit does not change the live-tested code.

All four new sessions completed with valid PASS, one ticket and exit code 0:

| Scenario | Applied faults | Local evidence directory |
| --- | --- | --- |
| baseline | 0 | `reports/homelab-baseline-warning-01/` |
| lost-ack 1 | 1 | `reports/homelab-lost-ack-warning-01/` |
| lost-ack 2 | 1 | `reports/homelab-lost-ack-warning-02/` |
| lost-ack 3 | 1 | `reports/homelab-lost-ack-warning-03/` |

Each fault run called create_ticket, received the injected after-timeout, then
called find_tickets; independent state and the creation ledger showed one ticket.
All four manifests record the same clean tested commit and prompt hash. Evidence
remains local and untracked, rather than being embedded in this README.

Historical attempts remain INVALID and are not regraded:

- Cloud CLI 0.167.0-alpha.4: model authentication failed with HTTP 401.
- `reports/homelab-baseline-3d25176-01/`, commit `3d25176`: disabled Code Mode
  host; no MCP calls.
- `reports/homelab-baseline-code-mode-01/`, commit `c0ff9b1`: one correlated
  creation, but the standard under-development notice was emitted as an error
  item. Only allowed_agent_activity failed; the session itself exited 0.

No live outcomes were retried. Maintainer review remains necessary before merge;
these local fixture results do not guarantee remote exactly-once behavior.

Official references checked 2026-11-12:
[CLI](https://developers.openai.com/codex/cli/reference/),
[configuration](https://developers.openai.com/codex/config-reference/),
[configuration schema](https://developers.openai.com/codex/config-schema.json),
[MCP](https://developers.openai.com/codex/mcp/), and
[authentication](https://developers.openai.com/codex/auth/).

### Code Mode runtime on CLI 0.167.2

The gpt-6.1-sol invocation enables `features.code_mode` and
`features.code_mode_host`. Disabling the host causes this model to fail closed
before issuing MCP calls, even when the CLI exits zero. The Linux npm distribution
bundles `codex-code-mode-host` beside its native `codex` executable; absence from
PATH alone is not a missing-host diagnosis. No global configuration or package
installation is needed for that distribution.

The existing MCP allowlist and workspace-only read permissions remain in force.
The evaluator still rejects runtime errors, missing MCP calls and unsupported
activity, including unverified Code Mode wrappers. A successful runtime startup
alone is not a valid baseline: agent calls and responses must correlate with the
proxy capture and independent fixture evidence.

The invocation also sets top-level `suppress_unstable_features_warning=true` to
acknowledge the deliberately enabled Code Mode feature required by this model.
This prevents the standard startup notice; actual runtime errors remain INVALID.
No event filtering or evaluator exceptions are used.
