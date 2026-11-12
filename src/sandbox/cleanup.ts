// src/sandbox/cleanup.ts

import type { Sandbox } from './interface.js';

/**
 * Cleanup registry — tracks active sandboxes for graceful shutdown.
 *
 * When the process exits (or crashes), we attempt to clean up
 * all sandboxes that were created but not yet cleaned.
 *
 * Usage:
 *   const registry = new CleanupRegistry();
 *   const sandbox = new TempFolderSandbox();
 *   registry.register(sandbox);
 *   ...
 *   await registry.cleanupAll();
 */

export class CleanupRegistry {
  private sandboxes: Set<Sandbox> = new Set();
  private installed = false;
  private shutdownCode?: number;

  /** Nonzero status captured when signal-driven cleanup begins. */
  get interruptionExitCode(): number | undefined {
    return this.shutdownCode;
  }

  /**
   * Register a sandbox for cleanup on process exit.
   */
  register(sandbox: Sandbox): void {
    this.sandboxes.add(sandbox);
    this.installExitHandlers();
  }

  /**
   * Unregister a sandbox (e.g., after manual cleanup).
   */
  unregister(sandbox: Sandbox): void {
    this.sandboxes.delete(sandbox);
  }

  /**
   * Clean up all registered sandboxes.
   */
  async cleanupAll(): Promise<void> {
    const tasks = Array.from(this.sandboxes).map((sandbox) =>
      sandbox.cleanup().catch((error) => {
        console.error(
          `[CleanupRegistry] Failed to clean sandbox "${sandbox.id}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      })
    );

    await Promise.all(tasks);
    this.sandboxes.clear();
  }

  /**
   * Install process exit handlers — cleanup on SIGINT / SIGTERM.
   * Idempotent: only installs once.
   */
  private installExitHandlers(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;

    const handler = async (signal: string): Promise<void> => {
      if (this.shutdownCode !== undefined) return;
      this.shutdownCode = Number(process.exitCode) || (signal === 'SIGINT' ? 130 : 143);
      process.exitCode = this.shutdownCode;
      // A caller may finish and explicitly exit(0) before async cleanup settles.
      // Enforce the nonzero status centrally, while respecting a command such as
      // demo that maps interruption to its own nonzero code in an exit listener.
      process.once('exit', () => {
        if (!Number(process.exitCode)) process.exitCode = this.shutdownCode;
      });
      console.error(`\n[CleanupRegistry] Received ${signal}, cleaning up...`);
      await this.cleanupAll();
      // Cleanup can overlap command completion or a newly detected failure.
      // Preserve a nonzero status; a late successful return cannot erase the signal.
      process.exit(Number(process.exitCode) || this.shutdownCode);
    };

    process.on('SIGINT', () => void handler('SIGINT'));
    process.on('SIGTERM', () => void handler('SIGTERM'));
  }
}

/**
 * Global cleanup registry — shared across the process.
 */
export const globalCleanupRegistry = new CleanupRegistry();
