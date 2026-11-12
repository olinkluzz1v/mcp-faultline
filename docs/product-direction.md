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
A ticket fixture is a proposed extension; current side-effect checks are
file-based.

## Reference projects

Use these projects as benchmarks for product decisions:

| Reference | What to study |
| --- | --- |
| [mcp-chaos](https://github.com/ajinb/mcp-chaos) | Its no-key demo, fault configuration, and separation of simulation and live proxy use. |
| [ResiliReplay](https://github.com/aliengineering-byte/resilireplay) | Its evidence, regression workflow, and explicit distinction between fixture and live validation. |

These references come from their documentation, reviewed on 2026-11-12.
We have not run a comparative benchmark. Do not claim missing competitor
features, uniqueness, or better speed or reliability without direct evidence.
Before release, recheck existing public comparisons against current sources.

Compare the same supported scenario and conditions. Record setup steps,
configuration effort, time to a useful result, clarity of evidence, and time to
rerun after a fix. Report installation and model latency separately from harness
overhead. Mark unsupported comparisons as not applicable. Improvement in a
specific workflow is enough; matching every competitor feature is not a goal.

## First useful release

1. Correct tool-result delivery and recording: fault status reaches the agent,
   successful synthetic data remains usable, and execution/injection counts
   reflect what actually happened.
2. A no-key local demo with known successful recovery and a known failure that
   the grader catches. Make the scripted nature of this demo explicit.
3. One documented integration tested end to end with a real agent and model,
   with exact versions, configuration, and evidence. A proxy connection or
   scripted fixture alone does not establish that integration.
4. Three small scenarios: transient timeout, lost acknowledgement after a
   successful write, and incomplete data. Each specifies acceptable outcomes,
   verifies independent state where applicable, and has a known bad control.
5. Clear offline HTML evidence, machine-readable results, and CI exit behavior
   that distinguishes passing expectations, failed expectations, and execution
   errors. Reuse the existing reporting core.
6. Save a scenario and rerun it against the changed agent in fresh isolated
   state. Reading a saved report or replaying old responses is not evidence that
   a new agent version has fixed the problem.

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
