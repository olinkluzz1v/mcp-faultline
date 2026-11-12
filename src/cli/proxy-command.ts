// src/cli/proxy-command.ts

/**
 * `faultline proxy` — long-running stdio proxy for external MCP agents.
 *
 * Mode 1 only: the proxy listens on its own stdin/stdout as an MCP
 * server and forwards traffic to a spawned real MCP server. Designed
 * to be registered in an external agent (e.g. Cline) as a command.
 *
 * All diagnostics go to stderr. stdout is reserved for JSON-RPC.
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { validateCapturePath, writeCapture } from '../proxy/capture.js';
import type { ProxyCapture } from '../proxy/types.js';
import type { ProxyClientHandle } from '../proxy/client.js';
import type { BridgeHandle } from '../proxy/bridge.js';
import { createProxyClient, ProxyClientCleanupError } from '../proxy/client.js';
import { createBridge } from '../proxy/bridge.js';
import { createFaultRuntime } from '../proxy/fault-runtime.js';
import {
  createProxyConfig,
  type ProxyConfig,
  type ProxyEvent,
} from '../proxy/types.js';
import type { FaultInjection } from '../task/schema.js';
import { loadTask } from '../task/loader.js';

// ---------------------------------------------------------------------------
// CLI arg shape
// ---------------------------------------------------------------------------

export interface ProxyCommandArgs {
  /** Full server command line, e.g. "node /path/to/server.js --port 3000". */
  readonly server: string;
  /** Optional task YAML — only its `fault_injection` array is used. */
  readonly task?: string;
  /** Optional working directory for the spawned server. */
  readonly cwd?: string;
  /** Opt-in session capture. Existing destinations are never replaced. */
  readonly capture?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split a server command line into command + args.
 *
 * Handles single quotes, double quotes, and backslash escapes at a
 * level sufficient for typical MCP server invocations. Not a full
 * shell parser — no variable expansion, no pipes, no redirection.
 *
 * Backslash behavior:
 *   - Outside quotes: treated as a literal character. This matters on
 *     Windows, where `tests\fixtures\server.js` must be preserved as-is.
 *   - Inside quotes: treated as an escape character. This is needed to
 *     handle `\"` (escaped quote) inside a quoted argument.
 */
function splitCommandLine(input: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    // Backslash is only an escape character inside a quote.
    // Outside quotes, it is a literal character (Windows path).
    if (ch === '\\' && (quote === '"' || quote === "'")) {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) tokens.push(current);

  if (tokens.length === 0) {
    throw new Error('proxy: --server is empty');
  }

  const [command, ...args] = tokens;
  return { command, args };
}

/**
 * Load `fault_injection` from an optional task YAML file.
 * Returns [] when no task is provided.
 */
async function loadFaultPlan(
  taskPath: string | undefined
): Promise<readonly FaultInjection[]> {
  if (!taskPath) return [];
  const task = await loadTask(taskPath);
  return task.fault_injection ?? [];
}

/**
 * Line-based stderr logger with a `[proxy]` prefix.
 * Never writes to stdout.
 */
function makeLogger(write: (text: string) => void): (
  event: ProxyEvent | Omit<ProxyEvent, 'index' | 'timestamp'>
) => void {
  return (event) => {
    const parts: string[] = ['[proxy]', event.type];
    if (event.message) parts.push('-', event.message);
    write(parts.join(' ') + '\n');
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runProxyCommand(args: ProxyCommandArgs): Promise<number> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const events: ProxyEvent[] = [];
  let diagnosticsFailed = false;
  let diagnosticsPending = Promise.resolve();
  const logger = makeLogger(diagnostic);
  const onEvent = (event: Omit<ProxyEvent, 'index' | 'timestamp'>): void => {
    if (args.capture !== undefined) events.push({ ...event, index: events.length, timestamp: Date.now() });
    logger(event);
  };
  const startup = new AbortController();
  let termination: ProxyCapture['termination'] | undefined;
  let exitCode = 0;
  let resolveStop!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  let connecting: Promise<ProxyClientHandle> | undefined;
  let initializing = false;
  let bridge: BridgeHandle | undefined;
  let capturePath: string | undefined;
  let faultPlan: readonly FaultInjection[] | undefined;
  let upstream: ProxyCapture['upstream'];
  let cleanupSucceeded = true;
  const errors: Array<ProxyCapture['errors'][number]> = [];

  function stop(reason: ProxyCapture['termination']['reason'], code: number, signal?: 'SIGINT' | 'SIGTERM'): void {
    // Keep the first termination cause, but a signal during finalization must
    // not allow an unfinished process to exit successfully.
    if (!exitCode && code) exitCode = code;
    if (termination) return;
    termination = { reason, ...(signal ? { signal } : {}) };
    // The SDK preserves McpError reasons; ordinary Errors are wrapped and lose
    // identity. Recognize only our own cancellation, not an unrelated failure.
    if (initializing) startup.abort(new McpError(ErrorCode.ConnectionClosed, 'Proxy session shutdown requested'));
    resolveStop();
  }
  function onDiagnosticError(error: Error): void {
    if (diagnosticsFailed) return;
    diagnosticsFailed = true;
    errors.push({ phase: 'diagnostics', message: error.message });
    exitCode = 2;
    stop('client_error', 2);
  }
  function diagnostic(text: string): void {
    if (diagnosticsFailed) return;
    diagnosticsPending = new Promise<void>(resolve => {
      try {
        process.stderr.write(text, error => {
          if (error) onDiagnosticError(error);
          resolve();
        });
      } catch (error) {
        onDiagnosticError(error instanceof Error ? error : new Error(String(error)));
        resolve();
      }
    });
  }
  const onEof = (): void => stop('client_eof', 0);
  const onSigint = (): void => stop('signal', 130, 'SIGINT');
  const onSigterm = (): void => stop('signal', 143, 'SIGTERM');
  const onStreamError = (error: Error): void => {
    exitCode = 2;
    onEvent({ type: 'proxy_error', actor: 'proxy', message: `Client stream failed: ${error.message}` });
    stop('client_error', 2);
  };
  process.stdin.on('end', onEof);
  process.stdin.on('error', onStreamError);
  process.stdout.on('error', onStreamError);
  process.stderr.on('error', onDiagnosticError);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  if (process.stdin.readableEnded) onEof();

  function failure(phase: 'setup' | 'cleanup', error: unknown): void {
    const message = error instanceof AggregateError
      ? `${error.message}: ${error.errors.map(e => e instanceof Error ? e.message : String(e)).join('; ')}`
      : error instanceof Error ? error.message : String(error);
    errors.push({ phase, message });
    exitCode = 2;
    onEvent({ type: 'proxy_error', actor: 'proxy', message: `${phase} failed: ${message}`, data: { phase } });
  }

  try {
    try {
      // Preflight happens before any upstream process is started. Final writing
      // uses exclusive creation too, to close the preflight/publication race.
      if (args.capture !== undefined) {
        try { capturePath = await validateCapturePath(args.capture); }
        catch (error) {
          throw new Error(`Capture destination invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const parsed = splitCommandLine(args.server);
      upstream = { command: parsed.command, args: parsed.args, cwd: resolve(args.cwd ?? process.cwd()) };
      faultPlan = await loadFaultPlan(args.task);
      if (!termination) {
        const config: ProxyConfig = createProxyConfig({ ...upstream, faultPlan });
        initializing = true;
        connecting = createProxyClient({ config, onEvent, signal: startup.signal })
          .finally(() => { initializing = false; });
        // Consume client protocol input immediately, even while the upstream
        // handshake is pending. Buffered initialize bytes must not hide EOF.
        bridge = await createBridge({ config, client: connecting, faultRuntime: createFaultRuntime({ faultPlan }), onEvent });
        void bridge.server.closed.then(() => {
          if (!termination) stop('client_closed', 2);
        });
        const client = await connecting;
        void client.exited.then(() => {
          if (!termination) stop('upstream_disconnect', 1);
        });
      }
      await stopped;
    } catch (error) {
      if (!(startup.signal.aborted && error === startup.signal.reason)) {
        if (error instanceof ProxyClientCleanupError) cleanupSucceeded = false;
        failure(error instanceof ProxyClientCleanupError ? 'cleanup' : 'setup', error);
        stop('setup_error', 2);
      }
    }

    // One finalization path; no signal handler calls process.exit(). Keep the
    // handlers installed until cleanup and capture writing have both finished.
    try {
      if (bridge) await bridge.close();
      else if (connecting) {
        const client = await connecting.catch(error => {
          if (error instanceof ProxyClientCleanupError) throw error;
          return undefined; // Setup already retained the connection failure.
        });
        await client?.close();
      }
    } catch (error) {
      cleanupSucceeded = false;
      failure('cleanup', error);
    }
    await diagnosticsPending;
    // This CLI owns stdin for one session, including failed startup paths.
    process.stdin.destroy();
    if (capturePath) {
      const capture: ProxyCapture = {
        kind: 'proxy-capture', schemaVersion: 1, runId, startedAt, endedAt: Date.now(),
        ...(upstream ? { upstream } : {}), ...(faultPlan === undefined ? {} : { faultPlan }),
        events, toolCalls: bridge?.toolCalls ?? [], faults: bridge?.faults ?? [],
        termination: termination ?? { reason: 'setup_error' },
        completion: exitCode === 0 ? 'completed' : exitCode === 130 || exitCode === 143 ? 'interrupted' : 'failed',
        cleanupSucceeded, captureStatus: 'complete', errors,
      };
      try {
        await writeCapture(capturePath, capture);
        diagnostic(`[proxy] capture saved: ${capturePath}\n`);
      } catch (error) {
        exitCode = 2;
        diagnostic(`[proxy] capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    diagnostic(`[proxy] stopped: ${termination?.reason ?? 'setup_error'} (exit ${exitCode})\n`);
    await diagnosticsPending;
    // Stream errors can follow their write callback on the next tick.
    await new Promise<void>(resolve => setImmediate(resolve));
    return exitCode;
  } finally {
    process.stdin.off('end', onEof);
    process.stdin.off('error', onStreamError);
    process.stdout.off('error', onStreamError);
    process.stderr.off('error', onDiagnosticError);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}
