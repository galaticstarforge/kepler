import type { McpToolResponse } from '../types.js';

/**
 * Sentinel marker field on an MCP tool response. The router checks for
 * this inside a structured content block and maps it to the HTTP 503
 * status code while keeping the response payload intact.
 */
export const SERVICE_UNAVAILABLE_MARKER = '__kepler_service_unavailable__';

export interface ServiceUnavailablePayload {
  readonly [SERVICE_UNAVAILABLE_MARKER]: true;
  message: string;
  details?: Record<string, unknown>;
}

export function SERVICE_UNAVAILABLE(
  message: string,
  details?: Record<string, unknown>,
): McpToolResponse {
  const payload: ServiceUnavailablePayload = details
    ? { [SERVICE_UNAVAILABLE_MARKER]: true, message, details }
    : { [SERVICE_UNAVAILABLE_MARKER]: true, message };
  return {
    isError: true,
    content: [
      { type: 'text', text: message },
      { type: 'structured', data: payload },
    ],
  };
}

export function isServiceUnavailable(response: McpToolResponse): boolean {
  if (!response.isError) return false;
  for (const block of response.content) {
    if (block.type === 'structured' && block.data && typeof block.data === 'object') {
      const data = block.data as Record<string, unknown>;
      if (data[SERVICE_UNAVAILABLE_MARKER] === true) return true;
    }
  }
  return false;
}
