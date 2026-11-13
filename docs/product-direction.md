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
this bounded oracle using independent local service state. One live baseline and
three fresh lost-ack runs passed under the documented configuration; see the
[validation summary](../examples/codex-ticket/README.md#offline-validation-and-references)
for the tested commit, exact versions and retained historical INVALID attempts.
The existing filesystem demo remains fully scripted.

## Shipped foundation

The current fork provides:

- YAML task and fault specifications, a scripted embedded agent, local filesystem
  assertions, recovery/integrity checks, and negative controls without API keys.
- Structured tool results in agent history, one record per wrapper invocation,
  synthetic success data, and separate execution/completion evidence. See the
  [tool-result contract](../ARCHITECTURE.md#tool-results-and-execution-evidence).
- JSON, Markdown, and standalone offline HTML reports, plus conversion of a saved
  batch to HTML without re-execution. See [reporting](reporting.md).
- Guided no-key local demos of a
  [lost write acknowledgement](../README.md#guided-local-demo-a-lost-acknowledgement)
  and a [transient timeout](../README.md#guided-local-demo-a-transient-timeout).
  Each compares two bounded scripted filesystem policies in fresh workspaces,
  retaining their actual FAIL/PASS grades while verifying the expected outcomes,
  applied fault, execution evidence and file assertions. Lost acknowledgement
  remains the default; `demo --scenario transient-timeout` selects the new scenario.
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
  The separate ticket example supplies bounded live end-to-end evidence and its
  own batch workflow; broader external-agent coverage remains a release goal.
- An opt-in [Codex CLI ticket example](../examples/codex-ticket/README.md) with a
  normal task, baseline and after-timeout YAML scenario, fresh sessions/state,
  invocation-scoped tool restrictions, and separate fixture-state verdicts.
  Captures, agent events, inputs/configuration and an independent creation ledger
  are retained. Offline controls check duplicate failures and verification before
  retry. The initial cloud model attempt failed authentication; subsequent local
  validation completed one baseline and three lost-ack runs, all valid PASS on
  `552af50aeac8dbed6e938b24299e6967beb5e0d5`. The requested model was
  `gpt-6.1-sol`; `modelReported` remains null. See the linked example summary for
  exact runtime versions and limits. This is bounded integration evidence, not
  a completed broader release claim.
- A [Codex ticket batch command](../examples/codex-ticket/README.md#batch-regression-workflow)
  records a predetermined no-fault baseline and sequential fresh lost-ack runs,
  with one explicit model and frozen prompt. Valid FAILs continue; INVALID,
  infrastructure failure or interruption stops scheduling and marks unstarted
  entries NOT RUN. Versioned JSON and offline HTML retain actual outcomes,
  independent fixture evidence and configuration provenance. Offline scripted
  integration tests cover this orchestration; live batch validation is pending.

These pieces include a locally validated Codex ticket integration; broader
external-agent coverage and live validation of the new batch workflow remain goals. The local
demo and embedded CI check do not validate a real LLM integration, and file-based
checks do not establish the outcomes of arbitrary external services.

## Architecture direction: CLI, desktop and integrations

The long-term product includes a local desktop application and an architecture
that can support different agents, models and providers. Validate the CLI
workflow first. CLI and desktop should share the same execution, verification
and reporting core so their evidence and outcome contracts remain consistent.

Provider-specific launching, authentication integration, event handling and
lifecycle behavior belong at the integration boundary. Support for a second
independent agent/provider should validate that boundary before we claim broad
compatibility. Document and test compatibility per integration **and transport**;
there is no universal-support claim.

Desktop support also requires addressing platform-specific process lifecycle and
cleanup limitations, including the current POSIX-only Codex launcher. A desktop
window alone does not resolve those constraints. The current batch increment
implements no desktop UI, additional provider or transport, or speculative
adapter framework. Those decisions follow evidence from the validated CLI and
second integration.

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

1. Extend validation beyond the completed one-baseline/three-lost-ack Codex
   ticket exercise. Other agent/model/CLI versions and broader fault scenarios
   still need their own fresh evidence; the four passing cases do not establish
   general compatibility or a reliability rate.
2. Extend the shipped lost-acknowledgement and transient-timeout demos with an
   equally guided incomplete-data scenario. Specify acceptable outcomes, verify
   independent state where applicable, and include a known bad control.
3. Live-validate the shipped Codex ticket batch command and its JSON/HTML and exit
   contracts. Broader integrations and automated comparisons between batches
   remain later work.
4. Validate the ticket example's fresh prompt/model rerun path with actual model
   access, then test a second independent integration before generalizing the
   architecture. Existing YAML scenarios can already be versioned. Reading a saved
   report or replaying old responses is not evidence that a new agent version
   has fixed the problem.
5. Build a local desktop workflow on the validated shared core, with explicit
   platform and transport support backed by lifecycle/cleanup tests.

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
