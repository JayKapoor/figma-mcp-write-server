/**
 * EXECUTE_CODE operation
 *
 * Runs arbitrary Plugin API JavaScript sent by the figma_execute tool.
 * The code is wrapped in an async function so top-level await and `return`
 * both work, mirroring how the official Figma MCP `use_figma` tool behaves.
 */

export async function EXECUTE_CODE(payload: any): Promise<any> {
  const code = payload?.code;
  if (typeof code !== 'string' || code.trim() === '') {
    throw new Error('EXECUTE_CODE requires a non-empty code string');
  }

  let fn: (figmaGlobal: typeof figma) => Promise<any>;
  try {
    // Async wrapper: enables top-level await and `return` in user code
    fn = new Function('figma', `return (async () => {\n${code}\n})();`) as any;
  } catch (error) {
    throw new Error(`Code failed to parse: ${error instanceof Error ? error.toString() : String(error)}`);
  }

  let result: any;
  try {
    result = await fn(figma);
  } catch (error) {
    throw new Error(`Code failed at runtime: ${error instanceof Error ? error.toString() : String(error)}`);
  }

  return { result: toSerializable(result) };
}

/**
 * Make an arbitrary return value safe to send over the WebSocket bridge.
 * Scene nodes and other Figma objects are not JSON-serializable, so they
 * collapse to a compact { id, type, name } reference.
 */
function toSerializable(value: any, depth: number = 0): any {
  if (value === null || value === undefined) return null;
  if (depth > 6) return String(value);

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'function' || t === 'symbol') return undefined;

  // Figma nodes: collapse to a reference instead of a circular dump
  if (t === 'object' && typeof value.id === 'string' && typeof value.type === 'string' && 'parent' in value) {
    return { id: value.id, type: value.type, name: (value as any).name ?? null };
  }

  if (Array.isArray(value)) {
    return value.map(item => toSerializable(item, depth + 1));
  }

  if (t === 'object') {
    if (value instanceof Uint8Array) {
      return { byteLength: value.byteLength, note: 'binary data omitted' };
    }
    const out: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      const serialized = toSerializable(value[key], depth + 1);
      if (serialized !== undefined) out[key] = serialized;
    }
    return out;
  }

  return String(value);
}
