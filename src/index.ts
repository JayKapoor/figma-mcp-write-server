#!/usr/bin/env node

import { FigmaMCPServer } from './mcp-server.js';
import { ServerConfig } from './types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createServer } from 'http';
import { logger } from './utils/logger.js';

const execAsync = promisify(exec);

// Utility function to check port status
async function checkPortStatus(port: number): Promise<void> {
  logger.log(`🔍 Checking port ${port} status...`);
  
  try {
    // Check if port is available
    const testServer = createServer();
    const isAvailable = await new Promise<boolean>((resolve) => {
      testServer.listen(port, () => {
        testServer.close(() => resolve(true));
      });
      testServer.on('error', () => resolve(false));
    });
    
    if (isAvailable) {
      logger.log(`🔌 Port ${port} is available`);
    } else {
      logger.log(`Port ${port} is in use`);
      
      // Find what's using the port
      try {
        const { stdout } = await execAsync(`lsof -ti :${port}`);
        const pids = stdout.trim().split('\n').filter(pid => pid);
        
        if (pids.length > 0) {
          logger.log(`📋 Process(es) using port ${port}:`);
          for (const pid of pids) {
            try {
              const { stdout: processInfo } = await execAsync(`ps -p ${pid} -o pid,comm,args --no-headers`);
              logger.log(`   PID ${pid}: ${processInfo.trim()}`);
            } catch (error) {
              logger.log(`   PID ${pid}: (process info unavailable)`);
            }
          }
          logger.log(`💡 To kill these processes: kill -9 ${pids.join(' ')}`);
        }
      } catch (error) {
        logger.log('   (Unable to identify processes using this port)');
      }
    }
  } catch (error) {
    logger.log(`Error checking port ${port}:`, error);
  }
}

// Parse command line arguments
async function parseArgs(): Promise<Partial<ServerConfig>> {
  const args = process.argv.slice(2);
  const config: Partial<ServerConfig> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    
    switch (key) {
      case '--port':
        if (value) config.port = parseInt(value, 10);
        break;
      case '--mcp-port':
        if (value) config.mcpPort = parseInt(value, 10);
        break;
      case '--check-port':
        if (value) {
          await checkPortStatus(parseInt(value, 10));
          process.exit(0);
        }
        break;
      case '--help':
      case '-h':
        logger.log(`
Figma MCP Write Server - Model Context Protocol server with Figma write access

Usage: figma-mcp-write-server [options]

Options:
  --port <number>              WebSocket server port for Figma plugin (default: 8765)
  --mcp-port <number>          HTTP port for Claude MCP connections (default: 3100)
  --check-port <number>        Check if a port is available and show what's using it
  --help, -h                   Show this help message

Description:
  Always-on MCP server with HTTP transport and WebSocket for Figma plugin.
  Runs as a daemon — Claude Code connects over HTTP, Figma plugin over WebSocket.

Architecture:
  Claude Code ↔ HTTP (port 3100) ↔ MCP Server ↔ WebSocket (port 8765) ↔ Figma Plugin

Setup:
  1. Start this server (or install as launchd daemon)
  2. Open Figma Desktop and import the plugin from figma-plugin/manifest.json
  3. Run the "Figma MCP Write Bridge" plugin - it will auto-connect
  4. Configure Claude Code: claude mcp add figma-write -s user --transport http http://localhost:3100/mcp

Endpoints:
  POST/GET/DELETE /mcp        MCP protocol (StreamableHTTP)
  GET /health                 Health check (JSON)

Examples:
  # Start server with default settings
  node dist/index.js

  # Start with custom ports
  node dist/index.js --port 9000 --mcp-port 3200

  # Check what's using port 8765
  node dist/index.js --check-port 8765
`);
        process.exit(0);
    }
  }
  
  return config;
}

async function main() {
  const config = await parseArgs();
  const server = new FigmaMCPServer(config);
  
  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.warn(`📡 Received ${signal}, shutting down gracefully...\n`);
    try {
      await server.stop();
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  };
  
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', { promise, reason }); 
    shutdown('unhandledRejection');
  });
  
  try {
    await server.start();
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
