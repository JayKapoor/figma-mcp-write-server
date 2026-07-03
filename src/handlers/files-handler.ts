import { ToolHandler, Tool } from '../types/index.js';
import * as yaml from 'js-yaml';

/**
 * Lists the Figma files that currently have a live plugin connection.
 * This is the discovery side of file-key routing: call this to see which
 * fileKey values can be passed to other tools.
 */
export class FilesHandler implements ToolHandler {
  private wsServer: any;

  constructor(_sendToPluginFn: (request: any) => Promise<any>, wsServer?: any) {
    this.wsServer = wsServer;
  }

  getTools(): Tool[] {
    return [
      {
        name: 'figma_files',
        description: 'List Figma files with a live plugin connection. Returns each file\'s fileKey and name. Pass a fileKey to any other tool to target that file.',
        inputSchema: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['list'],
              description: 'File connection operation to perform (default: list)'
            }
          }
        },
        examples: [
          '{"operation": "list"}'
        ]
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    if (toolName !== 'figma_files') {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const files = this.wsServer ? this.wsServer.getConnectedFiles() : [];
    const result = {
      connectedFiles: files.map((f: any) => ({
        fileKey: f.fileKey,
        fileName: f.fileName,
        connectedAt: f.connectedAt instanceof Date ? f.connectedAt.toISOString() : f.connectedAt
      })),
      count: files.length,
      ...(files.length === 0 && {
        hint: 'No files connected. Open a file in Figma and run the figma-write plugin there.'
      }),
      ...(files.length > 1 && {
        hint: 'Multiple files connected. Pass fileKey to other tools to target a specific file.'
      })
    };

    return {
      content: [{ type: 'text', text: yaml.dump(result, { indent: 2, lineWidth: 120 }) }],
      isError: false
    };
  }
}
