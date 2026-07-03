import { ToolHandler, Tool } from '../types/index.js';
import * as yaml from 'js-yaml';

/**
 * Runs arbitrary Figma Plugin API JavaScript inside the target file.
 * Complements the typed tools: use those for safe, structured edits and this
 * for anything the tool surface does not cover, or for large batch scripts.
 */
export class ExecuteHandler implements ToolHandler {
  private sendToPlugin: (request: any) => Promise<any>;

  constructor(sendToPluginFn: (request: any) => Promise<any>) {
    this.sendToPlugin = sendToPluginFn;
  }

  getTools(): Tool[] {
    return [
      {
        name: 'figma_execute',
        description: 'Execute JavaScript in the Figma plugin sandbox with full Plugin API access (the `figma` global). Code runs in an async context: use await freely and `return` a JSON-serializable value as the result. Font rule applies: load fonts via figma.loadFontAsync before mutating text.',
        inputSchema: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'JavaScript source to run. Wrapped in an async function, so top-level await and return work. The returned value is JSON-serialized back as the tool result.'
            },
            timeout: {
              type: 'number',
              minimum: 1000,
              maximum: 120000,
              description: 'Execution timeout in milliseconds (default: 30000)'
            }
          },
          required: ['code']
        },
        examples: [
          '{"code": "return figma.currentPage.name"}',
          '{"code": "const f = figma.createFrame(); f.resize(400, 300); f.name = \'Card\'; return { id: f.id }"}'
        ]
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    if (toolName !== 'figma_execute') {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    if (!args || typeof args.code !== 'string' || args.code.trim() === '') {
      throw new Error('figma_execute requires a non-empty code string');
    }

    const timeout = typeof args.timeout === 'number' ? args.timeout : 30000;

    const executePromise = this.sendToPlugin({
      type: 'EXECUTE_CODE',
      payload: {
        operation: 'execute',
        code: args.code
      }
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`figma_execute timed out after ${timeout}ms`)), timeout);
    });

    const response: any = await Promise.race([executePromise, timeoutPromise]);

    return {
      content: [{ type: 'text', text: yaml.dump({ result: response?.result ?? null }, { indent: 2, lineWidth: 120 }) }],
      isError: false
    };
  }
}
