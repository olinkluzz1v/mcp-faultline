// src/proxy/server.ts

/**
 * MCP server wrapper for the external-agent stdio proxy.
 *
 * Responsibility: expose an MCP server on our own stdin/stdout that
 * the external agent (Cline, etc.) connects to. This server is the
 * *front door* — everything the agent sends arrives here.
 *
 * Message routing to the real server happens in bridge.ts. This module
 * only handles the transport and forwards raw requests upward.
 *
 * Protocol note: per MCP stdio spec, stdout carries JSON-RPC only.
 * All diagnostics must go to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsRequest,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';

import type { ProxyEvent } from './types.js';

export type ProxyServerEvent = Omit<ProxyEvent, 'index' | 'timestamp'>;

export interface ProxyServerOptions {
  /** Called for every event the server produces. */
  readonly onEvent: (event: ProxyServerEvent) => void;

  /**
   * Handler invoked for every `tools/call` request from the agent.
   * Must return the raw MCP result to send back. Errors thrown here
   * are converted into MCP error responses, not crashes.
   */
  readonly onCallTool: (request: CallToolRequest) => Promise<CallToolResult>;

  /**
   * Handler invoked for every `tools/list` request from the agent.
   * Returning the real server's tool list (possibly filtered) keeps
   * the agent's view consistent with what it can actually call.
   */
  readonly onListTools: (request: ListToolsRequest) => Promise<ListToolsResult>;
}

export interface ProxyServerHandle {
  readonly server: Server;
  /** Resolves when the transport closes (agent disconnected). */
  readonly closed: Promise<void>;
  /** Gracefully close the server. Idempotent. */
  close(): Promise<void>;
}

function emit(
  onEvent: (event: ProxyServerEvent) => void,
  event: ProxyServerEvent
): void {
  try {
    onEvent(event);
  } catch {
    // A broken sink must not take down the proxy.
  }
}

/**
 * Build and start the proxy's front-facing MCP server.
 */
export async function createProxyServer(
  opts: ProxyServerOptions
): Promise<ProxyServerHandle> {
  const { onEvent, onCallTool, onListTools } = opts;

  const server = new Server(
    { name: 'faultline-proxy', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // --- tools/list -----------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    try {
      const result = await onListTools(request);
      emit(onEvent, {
        type: 'response_received',
        actor: 'server',
        message: 'tools/list response',
        data: { method: 'tools/list' },
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit(onEvent, {
        type: 'proxy_error',
        actor: 'proxy',
        message: `tools/list failed: ${message}`,
      });
      throw err;
    }
  });

  // --- tools/call -----------------------------------------------------
  // The bridge owns tool invocation identities and emits forwarding evidence
  // only when it actually calls upstream (an instead injection never does).
  server.setRequestHandler(CallToolRequestSchema, onCallTool);

  // --- transport ------------------------------------------------------
  const transport = new StdioServerTransport();

  let closedEmitted = false;
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => {
      if (closedEmitted) return;
      closedEmitted = true;
      emit(onEvent, {
        type: 'proxy_shutdown',
        actor: 'proxy',
        message: 'agent disconnected, proxy server closing',
      });
      resolve();
    };
  });

  await server.connect(transport);

  emit(onEvent, {
    type: 'proxy_start',
    actor: 'proxy',
    message: 'proxy server listening on stdio',
  });

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return closing ??= server.close();
  }

  return { server, closed, close };
}
