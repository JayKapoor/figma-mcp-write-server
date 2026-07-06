// Figma MCP Write Plugin - Main Entry Point
import { operationRouter } from './operation-router.js';
import { HandlerRegistry } from './types.js';
import { logger } from './logger.js';
import { UIMessageBridge } from './ui-message-bridge.js';
import { sanitizePayload } from './utils/payload-utils.js';
import { createOperationSuccessMessage, createOperationErrorMessage, createUnknownOperationMessage } from './utils/response-utils.js';

const uiMessageBridge = new UIMessageBridge();

class FigmaPlugin {
  private handlers: HandlerRegistry = {};

  constructor() {
    // Initialize plugin logger with UI bridge
    logger.initialize(uiMessageBridge);
    logger.debug('Figma MCP Write Plugin starting...');
    
    this.initializePlugin();
    this.setupUIMessageHandler();
  }

  private initializePlugin(): void {
    try {
      // Initialize the operation router (now synchronous)
      operationRouter.initialize();
      
      // Get all discovered operations
      this.handlers = operationRouter.getOperations();
      
      logger.debug(`Plugin initialized with ${Object.keys(this.handlers).length} operations`);
    } catch (error) {
      logger.error('Failed to initialize plugin:', error);
      throw error; // Fail fast instead of legacy fallback
    }
  }


  private setupUIMessageHandler(): void {
    // Handle messages from UI thread (which manages WebSocket connection)
    figma.ui.onmessage = async (msg) => {
      // Handle special plugin control messages (direct messages)
      if (msg.type === 'CLOSE') {
        logger.log('👋 Closing plugin');
        figma.closePlugin();
        return;
      }
      
      // Handle connection status updates from UI (direct messages)
      if (msg.type === 'CONNECTION_STATUS') {
        uiMessageBridge.setConnected(msg.connected);
        if (msg.connected) {
          logger.onConnectionRestored();
        }
        return;
      }
      
      // Handle operation messages from UI (wrapped in pluginMessage)
      const message = msg.pluginMessage || msg; // Support both wrapped and direct messages
      // Only log if there's an issue - remove success logging
      
      // Handle Base64 conversion responses (these are responses, not operations)
      if (message.type === 'CONVERT_BASE64_TO_UINT8ARRAY_RESPONSE') {
        // These responses are handled by the operation that initiated them (manage-fills, etc.)
        // No action needed here - they're processed by the awaiting operation
        return;
      }
      
      if (message.type && message.id && this.handlers[message.type]) {
        await this.handlePluginOperation(message.type, message.payload, message.id);
      } else {
        logger.error('Unknown message or missing handler:', message.type);
        figma.ui.postMessage(createUnknownOperationMessage(message.id, message.type));
      }
    };
  }

  // Handle operations from MCP server via UI thread
  private async handlePluginOperation(operation: string, payload: any, id: string): Promise<void> {
    try {
      const handler = this.handlers[operation];

      // Comprehensive null-safe payload handling
      const safePayload = !payload || typeof payload !== 'object' 
        ? {} 
        : sanitizePayload(payload);

      const result = await handler(safePayload);

      figma.ui.postMessage({ ...createOperationSuccessMessage(id, operation, result), page: this.currentPageName() });
      // Success - no logging needed

    } catch (error) {
      logger.error(`${operation} failed:`, error.toString());
      figma.ui.postMessage({ ...createOperationErrorMessage(id, operation, error), page: this.currentPageName() });
    }
  }


  private currentPageName(): string | null {
    try {
      return figma.currentPage?.name ?? null;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    try {
      // Show UI for WebSocket connection and monitoring.
      // themeColors injects --figma-color-* CSS variables so the UI matches
      // the user's light/dark Figma theme.
      figma.showUI(__html__, { width: 252, height: 420, themeColors: true });

      // Tell the UI thread which file we are in so it can announce itself to
      // the server (file-key routing). figma.fileKey needs enablePrivatePluginApi.
      this.sendFileIdentity();

      // Keep the UI's "working in" line current as the user moves between pages
      figma.on('currentpagechange', () => {
        figma.ui.postMessage({ type: 'PAGE_INFO', pageName: this.currentPageName() });
      });

      // Set up plugin lifecycle handlers
      this.setupLifecycleHandlers();

      // Plugin ready - no logging needed unless there's an error
    } catch (error) {
      logger.error('Plugin initialization failed:', error);
      figma.notify('Plugin initialization failed', { error: true });
    }
  }

  private sendFileIdentity(): void {
    let fileKey: string | null = null;
    let fileName: string | null = null;
    try {
      fileKey = (figma as any).fileKey ?? null;
    } catch {
      // fileKey unavailable (plugin not running with private plugin API)
    }
    try {
      fileName = figma.root?.name ?? null;
    } catch {
      // root not ready
    }
    figma.ui.postMessage({ type: 'FILE_IDENTITY', fileKey, fileName, pageName: this.currentPageName() });
  }

  private setupLifecycleHandlers(): void {
    // Handle plugin close
    figma.on('close', () => {
      logger.log('👋 Plugin closing...');
    });
  }


}

// Initialize and start the plugin
const plugin = new FigmaPlugin();
plugin.start().catch(error => {
  logger.error('Fatal error starting plugin:', error);
  figma.notify('Failed to start plugin', { error: true });
});

