import { TOOL_HANDLERS } from './handlers/index.js';
import { isServiceUnavailable } from './handlers/service-status.js';
import type { HandlerContext, McpToolResponse } from './types.js';
import { errorResponse } from './types.js';

export interface McpRequest {
  method: string;
  params: Record<string, unknown>;
  id?: string | number;
}

export interface McpResponse {
  id?: string | number;
  result?: McpToolResponse;
  error?: { code: number; message: string };
  /** Transport-level HTTP status hint; set when a tool signals service-unavailable. */
  httpStatus?: number;
}

export class McpRouter {
  constructor(private readonly ctx: HandlerContext) {}

  async handleToolCall(toolName: string, params: Record<string, unknown>): Promise<McpToolResponse> {
    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      return errorResponse(`Unknown tool: "${toolName}".`);
    }

    try {
      return await handler(params, this.ctx);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.logger.error('tool handler error', { tool: toolName, error: message });
      return errorResponse(`Internal error in ${toolName}: ${message}`);
    }
  }

  async handleRequest(request: McpRequest): Promise<McpResponse> {
    if (request.method === 'tools/call') {
      const toolName = request.params['name'] as string | undefined;
      const toolParams = (request.params['arguments'] as Record<string, unknown>) ?? {};

      if (!toolName) {
        return { id: request.id, error: { code: -32_602, message: 'Missing tool name' } };
      }

      const result = await this.handleToolCall(toolName, toolParams);
      if (isServiceUnavailable(result)) {
        return { id: request.id, result, httpStatus: 503 };
      }
      return { id: request.id, result };
    }

    if (request.method === 'tools/list') {
      const tools = Object.keys(TOOL_HANDLERS).map((name) => ({
        name,
        description: `Kepler ${name} tool`,
      }));
      return {
        id: request.id,
        result: { content: [{ type: 'structured' as const, data: { tools } }] },
      };
    }

    return { id: request.id, error: { code: -32_601, message: `Unknown method: ${request.method}` } };
  }

  listTools(): string[] {
    return Object.keys(TOOL_HANDLERS);
  }
}
