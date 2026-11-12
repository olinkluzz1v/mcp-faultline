// src/proxy/bridge.ts

/**
 * Bridge between the proxy's front-facing MCP server and the real
 * MCP server behind it.
 *
 * Responsibility: wire `server.ts` callbacks to `client.ts` methods,
 * consult `fault-runtime.ts` before every `tools/call`, and record
 * tool calls into a trajectory.
 *
 * This is the *only* module that knows about both sides of the proxy.
 * server.ts and client.ts stay single-purpose.
 *
 * Fault injection honors two modes:
 *   - `instead` : return the synthetic result, do NOT forward
 *   - `after`   : forward to the real server FIRST, then replace
 *                 the response with the synthetic one
 *
 * In an independently verified write scenario, `after` can hide a successful
 * acknowledgement and expose a retry. The proxy response alone does not prove
 * that the remote write occurred.
 */

import type { CallToolRequest, CallToolResult, ListToolsRequest, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolCallResult } from '../mcp/types.js';
import type { ProxyClientHandle } from './client.js';
import type { ProxyServerHandle } from './server.js';
import { createProxyServer } from './server.js';
import type { FaultRuntimeHandle } from './fault-runtime.js';
import type { ProxyConfig, ProxyEvent, ProxyFaultRecord, ProxyToolCallRecord } from './types.js';
import { syntheticResponse } from './response.js';

export type BridgeEvent = Omit<ProxyEvent, 'index' | 'timestamp'>;

export interface BridgeOptions {
  readonly config: ProxyConfig;
  /** A pending connection lets the front SDK transport consume input during startup. */
  readonly client: ProxyClientHandle | Promise<ProxyClientHandle>;
  readonly faultRuntime: FaultRuntimeHandle;
  readonly onEvent: (event: BridgeEvent) => void;
}

export interface BridgeHandle {
  readonly server: ProxyServerHandle;
  /** Completed observations ordered by invocation index, including overlapping calls. */
  readonly toolCalls: readonly ProxyToolCallRecord[];
  /** Applied faults ordered by invocation index. */
  readonly faults: readonly ProxyFaultRecord[];
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export async function createBridge(opts: BridgeOptions): Promise<BridgeHandle> {
  const { faultRuntime, onEvent } = opts;
  const clientReady = Promise.resolve(opts.client);
  const upstreamClosed = clientReady.then(client => client.exited, () => undefined);
  const toolCalls: ProxyToolCallRecord[] = [];
  const faults: ProxyFaultRecord[] = [];
  const counts = new Map<string, number>();
  const pending = new Set<Promise<unknown>>();
  const requests = new Set<AbortController>();
  let nextIndex = 0;
  let closing: Promise<void> | undefined;

  function emit(event: BridgeEvent): void {
    try { onEvent(event); } catch { /* A broken sink must not take down the bridge. */ }
  }

  function track<T>(request: Promise<T>): Promise<T> {
    pending.add(request);
    void request.then(() => pending.delete(request), () => pending.delete(request));
    return request;
  }

  async function forward<T>(send: (client: ProxyClientHandle, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (closing) throw new McpError(ErrorCode.ConnectionClosed, 'Proxy session closing');
    const controller = new AbortController();
    requests.add(controller);
    try {
      const client = await clientReady;
      controller.signal.throwIfAborted();
      return await send(client, controller.signal);
    } finally {
      // The SDK retains abort listeners after a request resolves. Discard its
      // controller too, so shutdown cancels only outstanding requests.
      requests.delete(controller);
    }
  }

  function handleListTools(request: ListToolsRequest): Promise<ListToolsResult> {
    return track(forward((client, signal) => {
      emit({ type: 'request_forwarded', actor: 'proxy', message: 'tools/list', data: { method: 'tools/list' } });
      return client.client.listTools(request.params, { signal });
    }));
  }

  async function callTool(request: CallToolRequest): Promise<CallToolResult> {
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};
    const index = nextIndex++;
    const callNumber = (counts.get(toolName) ?? 0) + 1;
    counts.set(toolName, callNumber);
    const identity = { callIndex: index, callNumber, toolName };
    const startedAt = Date.now();
    let result: ToolCallResult = { status: 'error', message: 'Tool call did not complete' };
    let forwarded = false;
    let upstreamOutcome: NonNullable<ProxyToolCallRecord['upstreamOutcome']> = 'not_forwarded';
    let upstreamResult: CallToolResult | undefined;
    let response: CallToolResult | undefined;

    try {
      const decision = faultRuntime.decide({ toolName, args, callNumber });
      const inject = (): CallToolResult => {
        if (!decision.inject) throw new Error('Missing injection decision');
        // Encode first: a failure to construct a response is not an injection.
        response = syntheticResponse(decision.result);
        result = decision.result;
        faults.push({ ...identity, mode: decision.mode, faultType: decision.faultType,
          schedule: decision.schedule, ...(decision.seed === undefined ? {} : { seed: decision.seed }) });
        faults.sort((a, b) => a.callIndex! - b.callIndex!);
        emit({ type: 'fault_injected', actor: 'injector',
          message: `Injected ${decision.faultType} (${decision.mode}) on ${toolName} (call #${callNumber})`,
          data: { ...identity, faultType: decision.faultType, schedule: decision.schedule, mode: decision.mode } });
        return response;
      };
      if (decision.inject && decision.mode === 'instead') return inject();

      // Validate the MCP envelope, not the application's output schema. A
      // transparent proxy must retain even tool errors with structured data;
      // the external client can apply its own tool output-schema validation.
      upstreamResult = await forward((client, signal) => {
        forwarded = true;
        upstreamOutcome = 'unknown';
        emit({ type: 'request_forwarded', actor: 'proxy', message: `tools/call ${toolName}`,
          data: { ...identity, method: 'tools/call' } });
        return client.client.request({ method: 'tools/call', params: request.params }, CallToolResultSchema, { signal });
      });
      upstreamOutcome = upstreamResult.isError === true ? 'tool_error' : 'success';
      emit({ type: 'response_received', actor: 'server', message: `tools/call ${toolName} response`,
        data: { ...identity, upstreamOutcome } });

      if (upstreamOutcome === 'tool_error') {
        result = { status: 'error', message: upstreamResult.content
          .filter(c => c.type === 'text').map(c => c.text).join('\n') || 'Upstream tool error' };
      } else if (decision.inject && decision.mode === 'after') {
        // A successful response permits replacement; it is not proof of a
        // remote side effect. Independent service-state evidence is needed.
        return inject();
      } else {
        result = { status: 'success', data: upstreamResult };
      }
      response = upstreamResult;
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { status: 'error', message };
      emit({ type: 'proxy_error', actor: 'proxy', message: `tools/call ${toolName} failed: ${message}`, data: identity });
      throw error; // Preserve SDK protocol errors; no applied after injection.
    } finally {
      toolCalls.push({ index, callNumber, toolName, args, result, startedAt,
        durationMs: Date.now() - startedAt, executed: forwarded ? 'unknown' : false,
        forwarded, upstreamOutcome, ...(upstreamResult === undefined ? {} : { upstreamResult }),
        ...(response === undefined ? {} : { response }) });
      toolCalls.sort((a, b) => a.index - b.index);
    }
  }

  function handleCallTool(request: CallToolRequest): Promise<CallToolResult> {
    return track(callTool(request));
  }

  const server = await createProxyServer({ onEvent: emit, onCallTool: handleCallTool, onListTools: handleListTools });
  const closed = Promise.race([server.closed, upstreamClosed]);
  function close(): Promise<void> {
    return closing ??= (async () => {
      // Settle observations even if a transport close fails. Stop accepting
      // new requests, and attempt both cleanups before reporting any failure.
      for (const request of requests) request.abort(new McpError(ErrorCode.ConnectionClosed, 'Proxy session closing'));
      const cleanup = await Promise.allSettled([
        clientReady.then(client => client.close(), () => undefined), server.close(),
      ]);
      await Promise.allSettled([...pending]);
      const errors = cleanup.filter(r => r.status === 'rejected').map(r => r.reason);
      if (errors.length) throw new AggregateError(errors, 'Proxy connection cleanup failed');
    })();
  }

  return { server, toolCalls, faults, closed, close };
}
