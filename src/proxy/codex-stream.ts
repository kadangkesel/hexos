// Codex stream transformer — stub for build verification
// Full implementation in Task 3

interface OpenAIMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

/**
 * Transform OpenAI Chat Completions request body to Codex Responses API body.
 */
export function buildCodexRequestBody(
  openaiBody: any,
  upstreamModel: string
): Record<string, unknown> {
  const input: any[] = [];
  let instructions = "";

  for (const msg of (openaiBody.messages || [])) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = typeof msg.content === "string"
        ? msg.content
        : (Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "");
      instructions += (instructions ? "\n" : "") + text;
    } else {
      input.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }
  }

  const body: Record<string, unknown> = {
    model: upstreamModel,
    input,
    stream: true,
    store: false,
  };

  if (instructions) body.instructions = instructions;
  if (openaiBody.temperature !== undefined) body.temperature = openaiBody.temperature;
  if (openaiBody.max_tokens !== undefined) body.max_output_tokens = openaiBody.max_tokens;
  if (openaiBody.top_p !== undefined) body.top_p = openaiBody.top_p;
  if (openaiBody.reasoning_effort) {
    body.reasoning = { effort: openaiBody.reasoning_effort };
  }

  return body;
}

/**
 * Rate limit info extracted from response headers.
 */
export interface CodexRateLimits {
  planType: string;
  primaryUsedPercent: number;
  secondaryUsedPercent: number;
  primaryWindowMinutes: number;
  secondaryWindowMinutes: number;
  primaryResetAt: number;
  secondaryResetAt: number;
}

/**
 * Extract rate limit info from Codex response headers.
 */
export function extractCodexRateLimits(headers: Headers): CodexRateLimits {
  return {
    planType: headers.get("x-codex-plan-type") || "unknown",
    primaryUsedPercent: parseInt(headers.get("x-codex-primary-used-percent") || "0", 10),
    secondaryUsedPercent: parseInt(headers.get("x-codex-secondary-used-percent") || "0", 10),
    primaryWindowMinutes: parseInt(headers.get("x-codex-primary-window-minutes") || "300", 10),
    secondaryWindowMinutes: parseInt(headers.get("x-codex-secondary-window-minutes") || "10080", 10),
    primaryResetAt: parseInt(headers.get("x-codex-primary-reset-at") || "0", 10),
    secondaryResetAt: parseInt(headers.get("x-codex-secondary-reset-at") || "0", 10),
  };
}

/**
 * Create a TransformStream that converts Codex Responses API SSE
 * into OpenAI Chat Completions SSE format.
 */
export function createCodexStreamTransformer(
  model: string,
  requestId: string
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let usageData: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null = null;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
          continue;
        }

        if (!line.startsWith("data: ")) continue;

        const dataStr = line.slice(6);
        if (!dataStr || dataStr === "[DONE]") continue;

        try {
          const data = JSON.parse(dataStr);

          if (currentEvent === "response.output_text.delta" || data.type === "response.output_text.delta") {
            const chunk = {
              id: `chatcmpl-${requestId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: data.delta || "" }, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } else if (currentEvent === "response.completed" || data.type === "response.completed") {
            if (data.response?.usage) {
              usageData = {
                input_tokens: data.response.usage.input_tokens,
                output_tokens: data.response.usage.output_tokens,
                total_tokens: data.response.usage.total_tokens,
              };
            }
            const chunk: Record<string, unknown> = {
              id: `chatcmpl-${requestId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            };
            if (usageData) {
              chunk.usage = {
                prompt_tokens: usageData.input_tokens || 0,
                completion_tokens: usageData.output_tokens || 0,
                total_tokens: usageData.total_tokens || 0,
              };
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } else if (currentEvent === "response.failed" || data.type === "response.failed") {
            const errorMsg = data.response?.error?.message || "Unknown error";
            const errorChunk = {
              error: { message: errorMsg, type: "server_error", code: "codex_error" },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
        } catch {
          // Skip unparseable lines
        }

        currentEvent = "";
      }
    },

    flush(_controller) {
      // Process any remaining buffer — ignore incomplete data
    },
  });
}
