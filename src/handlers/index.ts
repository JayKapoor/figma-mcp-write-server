import { Tool } from '@modelcontextprotocol/sdk/types';
import { ToolHandler, ToolResult } from '../types/index.js';
import * as path from "path";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { logger } from "../utils/logger.js"
import { fileKeyContext } from "../utils/file-context.js"

// Get version from package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
const VERSION = packageJson.version;

export class HandlerRegistry {
  private handlers = new Map<string, ToolHandler>();
  private allTools: Tool[] = [];
  private wsServer: any; // Reference to WebSocket server for health monitoring
  private sendToPlugin: (request: any) => Promise<any>;
  private fontServiceAccessor: (() => any) | undefined;
  private handlerRegistrationPromise: Promise<void>;
  

  constructor(sendToPluginFn: (request: any) => Promise<any>, wsServer?: any, fontServiceAccessor?: () => any) {
    this.wsServer = wsServer;
    this.sendToPlugin = sendToPluginFn;
    this.fontServiceAccessor = fontServiceAccessor;

    // Start handler registration immediately and capture the promise
    this.handlerRegistrationPromise = this.registerHandlers(sendToPluginFn);
  }

  private async registerHandlers(sendToPluginFn: (request: any) => Promise<any>): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      try {
        const handlerImports = this.discoverHandlers();

        for (const loader of handlerImports) {
          try {
            const handlerInfo = await loader();
            const { class: HandlerClass, name } = handlerInfo as any;
            if (HandlerClass) {
              let handler;
              if (name === 'PluginStatusHandler' || name === 'FilesHandler') {
                handler = new HandlerClass(sendToPluginFn, this.wsServer);
              } else if (name === 'FontsHandler' && this.fontServiceAccessor) {
                handler = new HandlerClass(sendToPluginFn, this.fontServiceAccessor);
              } else {
                handler = new HandlerClass(sendToPluginFn);
              }
              this.registerHandler(handler);
            }
          } catch (error) {
            // Log error but continue with other handlers
            logger.error(`Failed to load handler: ${error}`);
          }
        }
        resolve(); // All handlers processed (successfully or with logged errors)
      } catch (error) {
        reject(error); // Critical error during discovery or initial setup
      }
    });
  }

  async waitForHandlerRegistration(): Promise<void> {
    return this.handlerRegistrationPromise;
  }

  /**
   * Manual handler registration to avoid dynamic import issues
   * This ensures all handlers are properly loaded in all environments
   */
  private discoverHandlers(): (() => Promise<any>)[] {
    // Manual import list - update when adding new handlers
    const handlerImports = [
      () => import('./alignments-handler.js').then(m => ({ class: m.AlignmentHandler, name: 'AlignmentHandler' })),
      () => import('./annotations-handler.js').then(m => ({ class: m.AnnotationsHandler, name: 'AnnotationsHandler' })),
      () => import('./auto-layout-handler.js').then(m => ({ class: m.AutoLayoutHandler, name: 'AutoLayoutHandler' })),
      () => import('./boolean-handler.js').then(m => ({ class: m.BooleanOperationsHandler, name: 'BooleanOperationsHandler' })),
      () => import('./components-handler.js').then(m => ({ class: m.ComponentsHandler, name: 'ComponentsHandler' })),
      () => import('./constraints-handler.js').then(m => ({ class: m.ConstraintsHandler, name: 'ConstraintsHandler' })),
      () => import('./dev-resources-handler.js').then(m => ({ class: m.DevResourcesHandler, name: 'DevResourcesHandler' })),
      () => import('./effects-handler.js').then(m => ({ class: m.EffectsHandler, name: 'EffectsHandler' })),
      () => import('./exports-handler.js').then(m => ({ class: m.ExportsHandler, name: 'ExportsHandler' })),
      () => import('./fills-handler.js').then(m => ({ class: m.FillsHandler, name: 'FillsHandler' })),
      () => import('./strokes-handler.js').then(m => ({ class: m.StrokesHandler, name: 'StrokesHandler' })),
      () => import('./fonts-handler.js').then(m => ({ class: m.FontsHandler, name: 'FontsHandler' })),
      () => import('./hierarchy-handler.js').then(m => ({ class: m.HierarchyHandler, name: 'HierarchyHandler' })),
      () => import('./images-handler.js').then(m => ({ class: m.ImagesHandler, name: 'ImagesHandler' })),
      () => import('./instances-handler.js').then(m => ({ class: m.InstancesHandler, name: 'InstancesHandler' })),
      () => import('./measurements-handler.js').then(m => ({ class: m.MeasurementsHandler, name: 'MeasurementsHandler' })),
      () => import('./nodes-handler.js').then(m => ({ class: m.NodeHandler, name: 'NodeHandler' })),
      () => import('./pages-handler.js').then(m => ({ class: m.PagesHandler, name: 'PagesHandler' })),
      () => import('./plugin-status-handler.js').then(m => ({ class: m.PluginStatusHandler, name: 'PluginStatusHandler' })),
      () => import('./selections-handler.js').then(m => ({ class: m.SelectionHandler, name: 'SelectionHandler' })),
      () => import('./styles-handler.js').then(m => ({ class: m.StyleHandler, name: 'StyleHandler' })),
      () => import('./texts-handler.js').then(m => ({ class: m.TextHandler, name: 'TextHandler' })),
      () => import('./variables-handler.js').then(m => ({ class: m.VariablesHandler, name: 'VariablesHandler' })),
      () => import('./vectors-handler.js').then(m => ({ class: m.VectorsHandler, name: 'VectorsHandler' })),
      () => import('./files-handler.js').then(m => ({ class: m.FilesHandler, name: 'FilesHandler' })),
      () => import('./execute-handler.js').then(m => ({ class: m.ExecuteHandler, name: 'ExecuteHandler' }))
    ];

    return handlerImports;
  }



  private registerHandler(handler: ToolHandler): void {
    const tools = handler.getTools();
    tools.forEach((tool) => {
      this.handlers.set(tool.name, handler);
      this.allTools.push(tool);
    });
  }

  getTools(): Tool[] {
    // Every tool accepts an optional fileKey so calls can target a specific
    // connected Figma file instead of whichever file connected last.
    return this.allTools.map(tool => {
      const schema: any = tool.inputSchema;
      if (!schema || schema.type !== 'object' || schema.properties?.fileKey) {
        return tool;
      }
      return {
        ...tool,
        inputSchema: {
          ...schema,
          properties: {
            ...schema.properties,
            fileKey: {
              type: 'string',
              description: 'Target Figma file key. Required when multiple files are connected; use figma_files to list them. Defaults to the only connected file.'
            }
          }
        }
      } as Tool;
    });
  }

  async handleToolCall(name: string, args: any): Promise<any> {
    // Pop the routing param before schema validation; it applies to every tool
    let targetFileKey: string | undefined;
    if (args && typeof args === 'object' && 'fileKey' in args) {
      targetFileKey = typeof args.fileKey === 'string' && args.fileKey.trim() !== '' ? args.fileKey : undefined;
      delete args.fileKey;
    }

    // Check plugin connection for all tools except status/discovery tools
    if (name !== 'figma_plugin_status' && name !== 'figma_files') {
      if (!this.wsServer) {
        throw new Error(`MCP server not properly initialized. Please restart the MCP server.`);
      }
      
      const status = this.wsServer.getConnectionStatus();
      const isConnected = this.wsServer.isPluginConnected();
      
      // Check if Figma plugin is connected
      if (!isConnected) {
        throw new Error(`Figma plugin not connected. Please open Figma, install and start the MCP Write plugin, then try again.`);
      }
      
      // Validate plugin responsiveness via heartbeat (allow initial grace period)
      if (status.lastHeartbeat) {
        const timeSinceHeartbeat = Date.now() - new Date(status.lastHeartbeat).getTime();
        if (timeSinceHeartbeat > 35000) {
          throw new Error(`Figma plugin appears frozen (no response for ${Math.round(timeSinceHeartbeat/1000)}s). Please restart the plugin in Figma.`);
        }
      }
      // Note: No validation if lastHeartbeat is null - allows initial connection grace period
    }

    // Use the handler registry for all tools (including figma_plugin_status)
    const handler = this.handlers.get(name);
    if (!handler) {
      const availableTools = Array.from(this.handlers.keys()).join(', ');
      throw new Error(`Tool '${name}' not found. Available tools: ${availableTools}`);
    }

    // Run inside the file-key context so sendToPlugin routes to the right file
    return await fileKeyContext.run(targetFileKey, () => handler.handle(name, args));
  }
}