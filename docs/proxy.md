# Stdio proxy protocol and evidence

The proxy connects an MCP client to a local stdio MCP server:

```sh
node dist/cli.js proxy --server "node /absolute/path/to/server.mjs" --task /absolute/path/to/task.yaml
```

The optional task supplies its existing `fault_injection` plan. The CLI logs
diagnostics to stderr; stdout contains only MCP JSON-RPC messages during a session.
Add `--capture <file.json>` to retain a versioned JSON session capture. Without
that option the CLI creates no capture files. It does not produce an agent grade.

The opt-in [Codex ticket example](../examples/codex-ticket/README.md) runs a
separate, bounded state evaluator around this CLI. Its scripted controls are
covered in normal CI; live model validation is pending authentication. That
example does not add agent grading to the proxy or reinterpret its captures as
embedded reports.

## Capture a session

From the repository root after `npm ci` and `npm run build`, create the parent
directory and configure your MCP client to launch this command:

```sh
mkdir -p reports
node dist/cli.js proxy --server "node tests/fixtures/mock-mcp-server.mjs" --capture reports/proxy-session.json
```

The bundled fixture exposes an `echo` tool. The proxy waits for MCP requests on
stdin; when the client ends stdin, it cleans up the child and writes the capture.
Replace `--server` with your stdio server command. `--task` and `--cwd` retain
their existing meanings. Capture paths are relative to the proxy's working
directory, independently of the upstream `--cwd`.

For a complete no-key SDK-client example, use a fresh capture filename:

```sh
mkdir -p reports
node --input-type=module <<'JS'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'capture-example', version: '1' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [
    'dist/cli.js', 'proxy', '--server', 'node tests/fixtures/mock-mcp-server.mjs',
    '--capture', 'reports/proxy-session.json',
  ] }));
  console.log(await client.callTool({ name: 'echo', arguments: { message: 'hello' } }));
} finally {
  await client.close(); // Ends stdin; the proxy finalizes its capture before exiting.
}
JS
node -e "const c = require('./reports/proxy-session.json'); console.dir({ termination: c.termination, completion: c.completion, calls: c.toolCalls, faults: c.faults }, { depth: null })"
```

The destination's parent must already exist and be writable. Existing files,
directories, and symlinks (including dangling symlinks) are rejected **before
upstream startup**. Final writing uses exclusive creation, so a destination
created by another session after preflight is also never replaced. There is no
overwrite flag. New capture files use mode `0600` where POSIX permissions apply.

Captures are local files; the CLI does not upload them. No `process.env` or raw
credential configuration is serialized. **Tool payloads, command arguments,
and error messages can contain sensitive data**, and are not generically
redacted. Review captures before sharing or committing them. The example's
`reports/` directory is already gitignored.

## Capture format and termination

The `ProxyCapture` format has `kind: "proxy-capture"` and `schemaVersion: 1`.
It is distinct from an embedded `BatchReport`: it contains no grade, is not
accepted by the saved-report renderer, and must not be fed into embedded
grading or replay. It is not independent evidence of remote side effects.

| Field | Meaning |
| --- | --- |
| `runId`, `startedAt`, `endedAt` | Session identity and wall-clock milliseconds; the end timestamp follows connection cleanup. |
| `upstream` | Parsed command, arguments and effective working directory; absent if command parsing failed. |
| `faultPlan` | Effective loaded plan, including defaults; absent if loading failed. An empty array means a known empty plan. |
| `events` | Observed lifecycle events with ordered indexes and timestamps. |
| `toolCalls`, `faults` | Invocation observations and actually applied substitutions, as described below. |
| `termination` | First observed termination reason, with `signal` for SIGINT/SIGTERM. |
| `completion`, `cleanupSucceeded` | Session/cleanup outcome: `completed`, `interrupted`, or `failed`; this is not an agent verdict or proof that every tool finished. |
| `captureStatus` | `complete` in the serialized snapshot. Trust a capture only after a complete JSON write. |
| `errors` | Setup, cleanup and diagnostic-stream failures; capture-output errors are reported on stderr when available and by the process exit code. |

The termination reason is `client_eof`, `signal`, `upstream_disconnect`,
`setup_error`, or an unexpected client transport failure (`client_error` /
`client_closed`). An EOF can abandon outstanding calls: their unknown outcomes
remain in the capture, even when the session itself shuts down normally.

Proxy-specific exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Normal client EOF, successful cleanup and any requested capture write. |
| `1` | Unexpected upstream connection loss. |
| `2` | Invalid usage/configuration, setup, client transport, cleanup, or capture-output failure. |
| `130` / `143` | Handled SIGINT / SIGTERM, unless an earlier nonzero failure is retained or an infrastructure/output failure overrides it with `2`. |

Injected tool failures and upstream `isError` results alone do not fail the
proxy session. All termination paths await cleanup and available call records
before attempting capture output. Signals during finalization stay nonzero.
The SDK front transport consumes input while upstream initialization is pending,
so buffered client initialization messages cannot hide EOF. A broken diagnostic
pipe does not bypass cleanup/capture; it makes the process exit nonzero.
The snapshot describes observations up to writing; a later signal or output
failure can change the final process exit code. `run` and `demo` contracts are
unchanged. Unsuccessful termination is never logged as “exited cleanly.”

Handled termination can finalize the available evidence; **SIGKILL or machine
failure cannot guarantee a capture**. Until finalization there may be no file;
an interrupted or failed write may leave partial JSON. No crash-durability,
streaming journal, or guaranteed delivery to the external client is implied.

## Responses and applied faults

- Valid upstream results retain their content, `structuredContent`, `_meta`,
  and `isError`. Only the MCP-level `isError: true` denotes a tool error;
  fields such as `status` inside application data do not control the proxy.
- `instead` does not forward the invocation. `after` replaces only an observed
  successful tool response. An upstream `isError: true` response passes through
  unchanged, is recorded as an error, and applies no `after` injection.
- Rejected requests, invalid MCP results, and disconnected transports do not
  establish success and do not apply an `after` injection. Protocol request
  errors remain request errors, rather than being converted to tool success.
- Synthetic failures are MCP tool-error responses with `isError: true` and text
  content. A synthetic timeout response is **not evidence of a real transport
  timeout**. The proxy does not actually interrupt the transport for this fault.
- Synthetic success exposes the registry's intended payload as JSON text content,
  plus `structuredContent` for object payloads. Private `_fault` bookkeeping stays
  in internal records, outside the application response. Null is JSON text `null`.
  Ordinary upstream application fields, including `_fault`, are preserved.

This small adapter follows the installed MCP SDK 1.30.1
[server contract](https://ts.sdk.modelcontextprotocol.io/server). It validates
MCP envelopes using SDK schemas. It does not generate corruptions that satisfy
arbitrary tool output schemas: an external SDK client may still reject an
injected payload incompatible with that tool's schema. Schema-aware corruption,
additional transports, and a generic capture framework are outside this change.

## Remote observations

`BridgeHandle.toolCalls` contains one completed observation per invocation,
ordered by its zero-based `index`, allocated before forwarding. `callNumber` is
one-based **per tool**. Concurrent requests retain these identities even when
responses arrive out of order. Fault records include the matching `callIndex`,
`callNumber`, and applied `mode`; plans that did not apply are not fault records.
Lifecycle events remain separate from invocation records.

New `ProxyToolCallRecord` fields describe what the proxy actually knows:

| Field | Meaning |
| --- | --- |
| `forwarded` | An upstream request was attempted; delivery is not guaranteed. |
| `upstreamOutcome` | `not_forwarded`, observed `success`, observed `tool_error`, or `unknown` after a request/transport/protocol failure. |
| `upstreamResult` | The complete valid MCP response, when received, before any replacement. |
| `response` | The exact MCP response produced by the bridge, including synthetic responses. Absent for rejected requests; it does not establish receipt by the client. |
| `executed` | `false` for a short-circuit; `"unknown"` for a forwarded invocation. |

A successful response alone does not prove an arbitrary remote side effect.
An error or disconnect does not prove that nothing executed. Independent
test-service state is needed to establish outcomes such as a completed write.

**API compatibility:** the exported `ProxyToolCallRecord` reuses the common call
fields and adds the `"unknown"` alternative to the proxy's former boolean
`executed` field. Consumers must inspect `forwarded` and `upstreamOutcome` for
remote observations, not coerce `executed` to a boolean or feed proxy records
into embedded grading/replay. New proxy records do not set the embedded-only
`executionSucceeded` flag. Existing boolean values and missing legacy fields
remain readable but must not be upgraded into stronger evidence. Missing legacy
fault modes or call indexes remain unknown. Embedded trajectories, grading,
report schemas, replay, demo outcomes, and `run` exit codes are unchanged.

Proxy server callbacks now declare the SDK `CallToolResult`/`ListToolsResult`
return types instead of `unknown`. Custom callbacks should return those valid
MCP shapes. SDK transport callbacks remain owned by the SDK so disconnects reject
pending requests; bridge shutdown waits for their records and child cleanup.
Close calls share one completion promise and now propagate cleanup failures.
The optional `response` field is additive; legacy records without it remain
unknown. Setup can be cancelled with an optional client `AbortSignal`.
`BridgeOptions.client` also accepts a pending handle promise, used by the CLI to
start its front transport during upstream setup. Shutdown cancels only currently
outstanding requests, not historical completed requests.

## MCP protocol integration tests

```sh
npm run build
npm run test:proxy
```

These tests use a real SDK client, the production CLI, and a local SDK stdio
fixture server. They check forwarding, tool errors, both injection modes,
synthetic data, overlapping invocations, rejected/invalid requests, and a
disconnect after a real write. A subsequent read checks an after-timeout write.
Write counts and file contents come from isolated fixture state, independently
of proxy records; instrumentation is not exposed as a client tool. Tests read
the production capture after EOF, signals, disconnects and setup/cleanup errors;
they also verify path protection, output failures, protocol-only stdout, and
absence of captured environment values. Startup EOF includes a client that has
already sent initialization bytes; a closed stderr reader also retains its
capture. A small test-only preload surfaces a
cleanup error after performing real SDK cleanup. Tests use bounded requests and
remove their processes and temporary directories.

These are **MCP protocol integration tests**, not real-agent validation. They use
no LLM or credentials, establish no live-model compatibility, and do not prove
exactly-once behavior for arbitrary external services.

Coverage is limited to the existing `tools/list` and `tools/call` stdio bridge;
general cancellation, progress, and other MCP capabilities are not validated.
Records establish response substitution at the bridge, not guaranteed receipt
by an external agent. The CLI now handles stdin EOF directly; the EOF tests do
not depend on the SDK client escalating to a signal.
