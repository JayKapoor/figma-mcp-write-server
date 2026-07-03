import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { FigmaWebSocketServer } from '../../../src/websocket/websocket-server.js';
import { DEFAULT_WS_CONFIG } from '../../../src/types/server-config.js';
import { fileKeyContext } from '../../../src/utils/file-context.js';

const TEST_PORT = 18965;

/**
 * A fake Figma plugin: opens a socket, sends PLUGIN_HELLO with a fileKey,
 * and echoes every request back as a successful response tagged with which
 * "file" handled it.
 */
async function connectFakePlugin(port: number, fileKey: string | null, fileName: string | null): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ type: 'PLUGIN_HELLO', version: 'test', fileKey, fileName }));

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'HEARTBEAT') {
      ws.send(JSON.stringify({ type: 'HEARTBEAT_ACK' }));
      return;
    }
    if (message.type === 'BATCH_REQUEST') {
      ws.send(JSON.stringify({
        type: 'BATCH_RESPONSE',
        batchId: message.batchId,
        responses: message.requests.map((req: any) => ({ id: req.id, result: { handledBy: fileKey } }))
      }));
      return;
    }
    if (message.id) {
      ws.send(JSON.stringify({ id: message.id, result: { handledBy: fileKey } }));
    }
  });

  // Give the server a beat to register the hello
  await new Promise(resolve => setTimeout(resolve, 50));
  return ws;
}

describe('file-key routing', () => {
  let server: FigmaWebSocketServer;
  let sockets: WebSocket[] = [];

  beforeEach(async () => {
    server = new FigmaWebSocketServer({ ...DEFAULT_WS_CONFIG, port: TEST_PORT });
    await server.start();
    sockets = [];
  });

  afterEach(async () => {
    sockets.forEach(ws => { try { ws.close(); } catch { /* closed */ } });
    await server.stop();
  });

  it('registers connections with their fileKey and fileName', async () => {
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileA', 'Deck A'));
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileB', 'Deck B'));

    const files = server.getConnectedFiles();
    expect(files).toHaveLength(2);
    expect(files.map(f => f.fileKey)).toEqual(['fileA', 'fileB']);
    expect(files.map(f => f.fileName)).toEqual(['Deck A', 'Deck B']);
  });

  it('routes an explicit fileKey to the matching connection', async () => {
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileA', 'Deck A'));
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileB', 'Deck B'));

    const result = await server.sendToPlugin({ type: 'TEST_OP', payload: {} }, 'normal', 'fileB');
    expect(result.handledBy).toBe('fileB');
  });

  it('reads the fileKey from the async tool-call context', async () => {
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileA', 'Deck A'));
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileB', 'Deck B'));

    const result = await fileKeyContext.run('fileA', () =>
      server.sendToPlugin({ type: 'TEST_OP', payload: {} })
    );
    expect(result.handledBy).toBe('fileA');
  });

  it('uses the only connection when no fileKey is given', async () => {
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileA', 'Deck A'));

    const result = await server.sendToPlugin({ type: 'TEST_OP', payload: {} });
    expect(result.handledBy).toBe('fileA');
  });

  it('rejects when multiple files are connected and no fileKey is given', async () => {
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileA', 'Deck A'));
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileB', 'Deck B'));

    await expect(server.sendToPlugin({ type: 'TEST_OP', payload: {} }))
      .rejects.toThrow(/Multiple Figma files are connected/);
  });

  it('fails fast with a helpful error for an unknown fileKey', async () => {
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileA', 'Deck A'));

    await expect(server.sendToPlugin({ type: 'TEST_OP', payload: {} }, 'normal', 'nope'))
      .rejects.toThrow(/No plugin connection for file nope/);
  });

  it('removes a connection from the registry when it closes', async () => {
    const ws = await connectFakePlugin(server.getConfig().port, 'fileA', 'Deck A');
    sockets.push(ws);
    expect(server.getConnectedFiles()).toHaveLength(1);

    ws.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(server.getConnectedFiles()).toHaveLength(0);
    expect(server.isPluginConnected()).toBe(false);
  });

  it('updates identity via PLUGIN_IDENTITY after connect', async () => {
    const ws = new WebSocket(`ws://localhost:${server.getConfig().port}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });

    // Connect without identity (fileKey arrives late from the main thread)
    ws.send(JSON.stringify({ type: 'PLUGIN_HELLO', version: 'test' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.getConnectedFiles()[0]!.fileKey).toBeNull();

    ws.send(JSON.stringify({ type: 'PLUGIN_IDENTITY', fileKey: 'lateKey', fileName: 'Late File' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.getConnectedFiles()[0]!.fileKey).toBe('lateKey');
    expect(server.getConnectedFiles()[0]!.fileName).toBe('Late File');
  });

  it('replaces a stale connection that claims the same fileKey', async () => {
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileA', 'Deck A'));
    sockets.push(await connectFakePlugin(server.getConfig().port, 'fileA', 'Deck A (rerun)'));
    await new Promise(resolve => setTimeout(resolve, 100));

    const files = server.getConnectedFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.fileName).toBe('Deck A (rerun)');
  });
});
