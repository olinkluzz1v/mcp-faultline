# Stdio proxy protocol and evidence

The proxy connects an MCP client to a local stdio MCP server:

```sh
node dist/cli.js proxy --server "node /absolute/path/to/server.mjs" --task /absolute/path/to/task.yaml
```

The optional task supplies its existing `fault_injection` plan. The CLI logs
diagnostics to stderr; stdout contains only MCP JSON-RPC messages. It does not
currently export a graded external-agent report or a persistent capture.

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

## MCP protocol integration tests

```sh
npm run build
npm run test:proxy
```

These tests use a real SDK client, the production bridge, and a local SDK stdio
fixture server. They check forwarding, tool errors, both injection modes,
synthetic data, overlapping invocations, rejected/invalid requests, and a
disconnect after a real write. A subsequent read checks an after-timeout write.
Write counts and file contents come from isolated fixture state, independently
of proxy records; instrumentation is not exposed as a client tool. A real CLI
subprocess checks protocol-only stdout and cleanup. Tests use bounded requests
and remove their processes and temporary directories.

These are **MCP protocol integration tests**, not real-agent validation. They use
no LLM or credentials, establish no live-model compatibility, and do not prove
exactly-once behavior for arbitrary external services.

Coverage is limited to the existing `tools/list` and `tools/call` stdio bridge;
general cancellation, progress, and other MCP capabilities are not validated.
Records establish response substitution at the bridge, not guaranteed receipt
by an external agent. EOF alone does not currently shut down the proxy CLI: the
SDK client's bounded close escalates to SIGTERM, whose cleanup path is tested.
