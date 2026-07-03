import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-tool-call routing context.
 *
 * The MCP layer runs each tool call inside `fileKeyContext.run(fileKey, ...)`.
 * The WebSocket server reads the store when dispatching to a plugin connection,
 * so every handler gets file-key routing without threading a parameter through
 * each of them.
 */
export const fileKeyContext = new AsyncLocalStorage<string | undefined>();

export function getTargetFileKey(): string | undefined {
  return fileKeyContext.getStore();
}
