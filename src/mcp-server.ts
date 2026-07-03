import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer as createHttpServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as yaml from 'js-yaml';

import { ServerConfig, LegacyServerConfig, DEFAULT_WS_CONFIG, loadConfig } from './types/index.js';
import { FigmaWebSocketServer } from './websocket/websocket-server.js';
import { HandlerRegistry } from './handlers/index.js';
import { ResourceRegistry } from './resources/index.js';
import { FontService } from './services/font-service.js';
import { logger } from './utils/logger.js';

// Get package version dynamically
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const VERSION = packageJson.version;

export class FigmaMCPServer {
  private wsServer: FigmaWebSocketServer;
  private handlerRegistry: HandlerRegistry;
  private resourceRegistry: ResourceRegistry;
  private config: ServerConfig;
  private fontService: FontService | null = null;
  private httpServer: HttpServer | null = null;
  private sessions: Map<string, { server: Server; transport: StreamableHTTPServerTransport }> = new Map();

  constructor(configOverrides: Partial<ServerConfig> = {}) {
    // Load config from file system with overrides
    this.config = { ...loadConfig(), ...configOverrides };

    // Initialize WebSocket server with legacy config
    const wsConfig: LegacyServerConfig = {
      ...DEFAULT_WS_CONFIG,
      port: this.config.port
    };
    this.wsServer = new FigmaWebSocketServer(wsConfig);

    // Initialize handler registry with WebSocket communication
    this.handlerRegistry = new HandlerRegistry(
      (request: any) => this.wsServer.sendToPlugin(request),
      this.wsServer,
      () => this.fontService // Provide FontService accessor
    );

    // Initialize resource registry
    this.resourceRegistry = new ResourceRegistry(
      (request: any) => this.wsServer.sendToPlugin(request)
    );

    // Listen for plugin connection to trigger sync if needed
    this.wsServer.on('pluginConnected', () => {
      this.onPluginConnected();
    });

    // Note: setupHandlers will be called after handler registration in start()
  }

  private setupHandlers(server: Server) {
    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.handlerRegistry.getTools(),
      };
    });

    // List available resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: await this.resourceRegistry.getResources(),
      };
    });

    // List available prompts (empty for now)
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: [],
      };
    });

    // Handle resource requests
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      logger.log(`📄 MCP resource request: ${uri}`);

      try {
        return await this.resourceRegistry.getResourceContent(uri);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.toString() : String(error);

        return {
          uri: uri,
          contents: [
            {
              uri: uri,
              text: JSON.stringify({
                error: errorMessage,
                uri: uri,
                timestamp: new Date().toISOString()
              }, null, 2)
            }
          ]
        };
      }
    });

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      logger.log(`🔧 MCP tool call received: ${name}`, args);

      try {
        return await this.handlerRegistry.handleToolCall(name, args || {});
      } catch (error) {
        const errorMessage = error instanceof Error ? error.toString() : String(error);

        const errorData = {
          error: errorMessage,
          tool: name,
          timestamp: new Date().toISOString()
        };

        return {
          content: [
            {
              type: "text",
              text: yaml.dump(errorData, {
                indent: 2,
                quotingType: '"',
                forceQuotes: false
              })
            }
          ],
          isError: true
        };
      }
    });
  }

  private createSessionServer(): { server: Server; transport: StreamableHTTPServerTransport } {
    const server = new Server(
      {
        name: 'figma-mcp-write-server',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    this.setupHandlers(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    return { server, transport };
  }

  async start(): Promise<void> {
    // Start WebSocket server (port 8765 for Figma plugin)
    await this.wsServer.start();

    // Wait for handler registration
    await this.handlerRegistry.waitForHandlerRegistration();

    // Create HTTP server for MCP connections (per-session transport)
    this.httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '', `http://localhost:${this.config.mcpPort}`);

      if (url.pathname === '/mcp') {
        // Check for existing session
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (sessionId && this.sessions.has(sessionId)) {
          // Route to existing session
          const session = this.sessions.get(sessionId)!;
          await session.transport.handleRequest(req, res);
        } else if (!sessionId) {
          // New session — create server + transport
          const session = this.createSessionServer();
          await session.server.connect(session.transport);

          // Clean up session when transport closes
          session.transport.onclose = () => {
            const sid = session.transport.sessionId;
            if (sid) {
              this.sessions.delete(sid);
              logger.log(`🔌 MCP session closed: ${sid}`);
            }
          };

          // Handle the request (this will process the initialize)
          await session.transport.handleRequest(req, res);

          // Store session after successful handling
          const sid = session.transport.sessionId;
          if (sid) {
            this.sessions.set(sid, session);
            logger.log(`🔌 New MCP session created: ${sid}`);
          }
        } else {
          // Unknown session ID — tell client to reinitialize
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Session not found. Please reinitialize.' },
            id: null,
          }));
        }
      } else if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          pluginConnected: this.wsServer.isPluginConnected(),
          connectedFiles: this.wsServer.getConnectedFiles(),
          version: VERSION,
          pid: process.pid,
          activeSessions: this.sessions.size,
        }));
      } else {
        res.writeHead(404).end('Not found');
      }
    });

    // Listen on mcpPort (default 3100) for Claude MCP connections
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.config.mcpPort, '0.0.0.0', () => resolve());
      this.httpServer!.on('error', reject);
    });

    // Initialize font database immediately (check state first)
    await this.initializeFontDatabase();

    logger.log('🚀 MCP server started (HTTP mode), waiting for plugin connection...', {
      version: VERSION,
      mcpPort: this.config.mcpPort,
      wsPort: this.config.port,
      pid: process.pid,
    });

    // Reset health metrics after MCP server starts
    await this.resetHealthMetrics();
  }
  
  private async initializeFontDatabase(): Promise<void> {
    // Prevent multiple initializations
    if (this.fontService) {
      return;
    }

    try {
      if (this.config.fontDatabase?.enabled !== false) {
        // Create FontService which will handle database initialization
        this.fontService = new FontService(
          (request: any) => this.wsServer.sendToPlugin(request),
          {
            databasePath: this.config.fontDatabase?.databasePath,
            enableDatabase: true
          }
        );
      }
    } catch (error) {
      logger.warn('Failed to initialize font database:', error);
    }
  }

  private async onPluginConnected(): Promise<void> {
    logger.log('🔤 Checking font database status...');
    if (this.fontService) {
      // Check if sync is needed now that plugin is connected
      await this.fontService.checkAndSyncIfNeeded();
    } else {
      logger.log('🔤 Font Service not available');
    }
  }

  private async resetHealthMetrics(): Promise<void> {
    try {
      // Wait a moment for potential plugin connection, then reset metrics
      setTimeout(() => {
        this.wsServer.resetHealthMetrics();
      }, 500); // Short delay to allow any pending operations to complete
    } catch (error) {
      logger.error('Failed to reset health metrics:', error);
    }
  }

  async stop(): Promise<void> {
    // Close all active MCP sessions
    for (const [sid, session] of this.sessions) {
      try {
        await session.transport.close();
        await session.server.close();
      } catch (error) {
        logger.warn(`Error closing session ${sid}:`, error);
      }
    }
    this.sessions.clear();

    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    }
    await this.wsServer.stop();
  }

  getConnectionStatus() {
    return {
      pluginConnected: this.wsServer.isPluginConnected(),
      connectionCount: this.wsServer.getConnectionCount(),
      wsPort: this.config.port,
      mcpPort: this.config.mcpPort
    };
  }

  getConfig(): ServerConfig {
    return this.config;
  }
}