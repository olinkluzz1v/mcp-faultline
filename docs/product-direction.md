# Product direction

Agreed direction, 2026-11-12. This document describes the fork's intended product,
not a claim that all capabilities below have shipped. Current commands and
limitations remain documented in [README.md](../README.md).

## The promise

Help developers who build MCP-connected agents answer a concrete question:
when a tool fails, does the agent still produce an acceptable result?

Keep the workflow short: connect a supported agent, select a controlled failure,
define the expected outcome, inspect evidence, and retain the scenario as a
regression test. The user supplies task-specific success criteria; the tool
cannot infer the correct behavior of every application.

The first example should be easy to explain: a ticket is created, its response
is lost, and the agent retries. Did it create a duplicate, verify the first
operation, or stop with an accurate explanation? Check independent test-service
state against explicit expectations, rather than trusting the agent's claim.
The [ticket fixture example](../examples/codex-ticket/README.md) now implements
this bounded oracle using independent local service state. Its live model
validation is pending; the existing filesystem demo remains fully scripted.

## Shipped foundation

The current fork provides:

- YAML task and fault specifications, a scripted embedded agent, local filesystem
  assertions, recovery/integrity checks, and negative controls without API keys.
- Structured tool results in agent history, one record per wrapper invocation,
  synthetic success data, and separate execution/completion evidence. See the
  [tool-result contract](../ARCHITECTURE.md#tool-results-and-execution-evidence).
- JSON, Markdown, and standalone offline HTML reports, plus conversion of a saved
  batch to HTML without re-execution. See [reporting](reporting.md).
- A guided [no-key local demo](../README.md#guided-local-demo-a-lost-acknowledgement)
  of a lost write acknowledgement. Two scripted filesystem policies retain their
  actual FAIL/PASS grades; the demo verifies both expected outcomes and their evidence.
- A [CI exit contract for `run`](../README.md#use-run-as-a-ci-check): success requires
  a nonempty passing batch and successful report writes; failed grades return `1`,
  configuration/infrastructure errors return `2`, and interruptions remain nonzero.
- Single-run replay using recorded responses and completed writes in a fresh
  sandbox, within the documented partial-effect and legacy-record limits.
- A stdio proxy with [MCP protocol integration tests](proxy.md) using an SDK
  client and isolated fixture server: faithful responses, applied-fault evidence,
  concurrent invocation identities, and independent write checks. Remote
  forwarding and responses are distinguished from proof of side effects.
  Opt-in JSON session captures now retain the effective plan, lifecycle events,
  original and produced responses, and termination outcome. EOF, signals and
  upstream loss share cleanup/finalization; capture-output errors stay nonzero.
  Captures are protocol evidence, without external-agent grading or replay.
  A versioned, reproducible real-agent and model workflow still needs the live
  end-to-end evidence specified below.
- An opt-in [Codex CLI ticket example](../examples/codex-ticket/README.md) with a
  normal task, baseline and after-timeout YAML scenario, fresh sessions/state,
  invocation-scoped tool restrictions, and separate fixture-state verdicts.
  Captures, agent events, inputs/configuration and an independent creation ledger
  are retained. Offline controls check duplicate failures and verification before
  retry; the actual Codex model attempt was blocked by authentication. This is
  an implemented integration path awaiting live validation, not a completed
  real-agent/model release claim.

These pieces support the intended workflow; the real-agent integration and fresh
external-agent regression experience below are still release goals. The local
demo and embedded CI check do not validate a real LLM integration, and file-based
checks do not establish the outcomes of arbitrary external services.

## Reference projects

Use these projects as references for product decisions:

| Reference | What to study |
| --- | --- |
| [mcp-chaos](https://github.com/ajinb/mcp-chaos) | Its no-key demo, fault configuration, and separation of simulation and live proxy use. |
| [ResiliReplay](https://github.com/aliengineering-byte/resilireplay) | Its evidence, regression workflow, and explicit distinction between fixture and live validation. |

Reviewed README snapshots on 2026-11-12:
[mcp-chaos at a74bb67](https://github.com/ajinb/mcp-chaos/blob/a74bb67e110cd157436cba8b9c4f1f75205c5684/README.md)
and [ResiliReplay at f101725](https://github.com/aliengineering-byte/resilireplay/blob/f1017259316c892b33a7b23f7a8a3a9586df0eaa/README.md).
We have not run a comparative benchmark. Do not claim missing competitor
features, uniqueness, or better speed or reliability without direct evidence.
Before release, recheck existing public comparisons against current sources.

Compare the same supported scenario and conditions. Record setup steps,
configuration effort, time to a useful result, clarity of evidence, and time to
rerun after a fix. Report installation and model latency separately from harness
overhead. Mark unsupported comparisons as not applicable. Improvement in a
specific workflow is enough; matching every competitor feature is not a goal.

## Remaining goals for the first focused release

1. Complete live validation of the documented Codex ticket integration: one
   baseline and three fresh fault runs with the same prompt/model, retaining all
   outcomes and exact versions/configuration. A proxy connection or scripted
   fixture alone does not establish that integration.
2. Extend the shipped lost-acknowledgement demo with equally guided transient-timeout
   and incomplete-data scenarios. Each specifies acceptable outcomes, verifies
   independent state where applicable, and has a known bad control.
3. Carry the existing reports and tested CLI/CI exit behavior into the supported
   external-agent workflow, with fresh evidence for that integration.
4. Validate the ticket example's fresh prompt/model rerun path with actual model
   access. Existing YAML scenarios can already be versioned. Reading a saved
   report or replaying old responses is not evidence that a new agent version
   has fixed the problem.

Use local disposable fixtures for the demonstration. Fault schedules and checks
can be repeatable while model behavior varies: retain relevant configuration,
record repeated live runs, and describe their limits. Passing selected cases is
evidence about those cases, not a universal reliability guarantee.

## Simplicity rules

- Prefer one local CLI and shared core. Use existing dependencies and built-ins
  when sufficient; justify each new runtime dependency.
- Optimize for the user's steps, clear results, and maintainability. Line count
  is a useful warning sign, not a reason to remove validation or regression tests.
- Add an abstraction only for a concrete repeated need. Keep changes focused.
- Defer hosted accounts, billing, dashboards, model rankings, broad adapter
  catalogs, and automatic fix generation until actual users establish a need.
- Preserve the MIT license and Gigih Susetyo's original authorship. Identify this
  work as an extension of MCP-Faultline.

## Release test

Ask three developers who did not build the project to follow the instructions.
Can they run the demo, explain its failure, connect the supported agent, and
retain a useful regression scenario without maintainer intervention?
Measure where they get stuck. Aim for a first demo within five minutes after
runtime prerequisites are installed; measure setup separately. Publish timing
claims only after testing them under stated conditions.

Ship when this bounded workflow works reliably, then prioritize observed user
problems. A PR should improve the trustworthiness of results, reduce user effort,
or remove a demonstrated obstacle.

## Illustrative launch copy

Future-facing draft; publish only when the described workflow has been verified:

> A ticket gets created, but the response never arrives. Your AI agent retries.
> Now there are two tickets.
>
> That is the kind of problem this MCP-Faultline fork helps you test.
>
> Projects like mcp-chaos and ResiliReplay already explore this space. Our focus
> is a short path from "what happens if this tool fails?" to a repeatable test
> with a clear result.
>
> Connect a supported agent, choose a failure scenario, and define what should
> happen. Check the actual outcome, inspect the relevant tool calls, and keep
> the scenario as a regression test after a fix.
>
> Local first. Open source. A demo that needs no API key.
>
> Built on Gigih Susetyo's MCP-Faultline.

Use confident, bounded claims about the job we do. Avoid both "the best" and
"we are not the best"; neither tells a developer whether the tool fits their
problem. Paid model usage, when applicable, is separate from the no-key demo.
