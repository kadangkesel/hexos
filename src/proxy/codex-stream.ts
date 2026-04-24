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
    } else if (msg.role === "tool") {
      // Tool result — convert to Responses API function_call_output format
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    } else if (msg.role === "assistant" && msg.tool_calls) {
      // Assistant message with tool calls — convert to function_call items
      if (msg.content) {
        input.push({ role: "assistant", content: msg.content });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: "function_call",
          id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments || "{}",
        });
      }
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
  // Note: Codex Responses API does NOT support temperature, top_p, max_output_tokens, etc.
  // Only pass: model, input, stream, store, instructions, reasoning, tools, tool_choice

  if (openaiBody.reasoning_effort) {
    body.reasoning = { effort: openaiBody.reasoning_effort };
  }

  // Convert OpenAI tools format to Responses API format
  if (Array.isArray(openaiBody.tools) && openaiBody.tools.length > 0) {
    body.tools = openaiBody.tools.map((t: any) => {
      if (t.type === "function") {
        return {
          type: "function",
          name: t.function?.name,
          description: t.function?.description || "",
          parameters: t.function?.parameters || { type: "object", properties: {} },
        };
      }
      return t;
    });
  }

  if (openaiBody.tool_choice !== undefined) {
    body.tool_choice = openaiBody.tool_choice;
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
  // Track tool calls: Responses API sends function_call items, we accumulate and emit as OpenAI tool_calls
  const pendingToolCalls: Map<string, { id: string; name: string; arguments: string }> = new Map();

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
          const evType = currentEvent || data.type || "";

          if (evType === "response.output_text.delta") {
            const chunk = {
              id: `chatcmpl-${requestId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: data.delta || "" }, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

          } else if (evType === "response.output_item.added") {
            // Tool call started — Responses API sends {item: {type: "function_call", id, name, ...}}
            const item = data.item;
            if (item?.type === "function_call") {
              pendingToolCalls.set(item.id, { id: item.id, name: item.name || "", arguments: "" });
              // Emit initial tool_calls delta with id and function name
              const tcChunk = {
                id: `chatcmpl-${requestId}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: pendingToolCalls.size - 1,
                      id: item.id,
                      type: "function",
                      function: { name: item.name || "", arguments: "" },
                    }],
                  },
                  finish_reason: null,
                }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(tcChunk)}\n\n`));
            }

          } else if (evType === "response.custom_tool_call_input.delta") {
            // Tool call arguments streaming
            const callId = data.item_id;
            const tc = callId ? pendingToolCalls.get(callId) : null;
            if (tc && data.delta) {
              tc.arguments += data.delta;
              const idx = [...pendingToolCalls.keys()].indexOf(callId);
              const argChunk = {
                id: `chatcmpl-${requestId}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: idx >= 0 ? idx : 0,
                      function: { arguments: data.delta },
                    }],
                  },
                  finish_reason: null,
                }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(argChunk)}\n\n`));
            }

          } else if (evType === "response.output_item.done") {
            // Tool call or message completed
            const item = data.item;
            if (item?.type === "function_call" && item.id) {
              // Update final arguments
              const tc = pendingToolCalls.get(item.id);
              if (tc) {
                tc.arguments = item.arguments || tc.arguments;
              }
            }

          } else if (evType === "response.completed") {
            if (data.response?.usage) {
              usageData = {
                input_tokens: data.response.usage.input_tokens,
                output_tokens: data.response.usage.output_tokens,
                total_tokens: data.response.usage.total_tokens,
              };
            }
            const finishReason = pendingToolCalls.size > 0 ? "tool_calls" : "stop";
            const chunk: Record<string, unknown> = {
              id: `chatcmpl-${requestId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
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

          } else if (evType === "response.failed") {
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
