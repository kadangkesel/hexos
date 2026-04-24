/**
 * Qoder SSE Stream Parser
 *
 * Converts Qoder's SSE response format to standard OpenAI SSE format.
 *
 * Qoder SSE wraps OpenAI-compatible chunks in an envelope:
 *   data:{"headers":{"Content-Type":["application/json"]},"body":"{...OpenAI chunk...}","statusCodeValue":200,"statusCode":"OK"}
 *   data:[DONE]
 *
 * The inner "body" field contains a standard OpenAI chat.completion.chunk JSON string.
 * We unwrap it and re-emit as standard OpenAI SSE.
 */

import { log } from "../utils/logger.ts";

export interface QoderStreamUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Convert Qoder SSE response to OpenAI-compatible SSE stream.
 *
 * @param res - Fetch Response from Qoder inference endpoint
 * @param model - Model name to inject into chunks (Qoder always returns "auto")
 * @returns Object with the transformed Response and a usage promise
 */
export function qoderToOpenAIStream(
  res: Response,
  model: string,
): { response: Response; usagePromise: Promise<QoderStreamUsage> } {
  let usageResolve: (usage: QoderStreamUsage) => void;
  const usagePromise = new Promise<QoderStreamUsage>((resolve) => {
    usageResolve = resolve;
  });

  let promptTokens = 0;
  let completionTokens = 0;

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush remaining buffer
            if (buffer.trim()) {
              processLines(buffer, controller, model);
            }
            // Send [DONE]
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            usageResolve!({ promptTokens, completionTokens });
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Handle data: prefix
            if (trimmed.startsWith("data:")) {
              const payload = trimmed.slice(5).trim();

              // End of stream
              if (payload === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                usageResolve!({ promptTokens, completionTokens });
                return;
              }

              try {
                const envelope = JSON.parse(payload);

                // Check for error status
                if (envelope.statusCodeValue && envelope.statusCodeValue >= 400) {
                  log.error(`[Qoder SSE] Error status: ${envelope.statusCode} (${envelope.statusCodeValue})`);
                  const errorChunk = {
                    choices: [{
                      delta: { content: `[Qoder Error: ${envelope.statusCode}]` },
                      index: 0,
                      finish_reason: "stop",
                    }],
                    model,
                    object: "chat.completion.chunk",
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
                  continue;
                }

                // Parse inner body (OpenAI-compatible chunk)
                if (envelope.body) {
                  let chunk: any;
                  try {
                    chunk = typeof envelope.body === "string"
                      ? JSON.parse(envelope.body)
                      : envelope.body;
                  } catch {
                    // Body is not JSON — might be raw text
                    log.warn(`[Qoder SSE] Non-JSON body: ${String(envelope.body).slice(0, 100)}`);
                    continue;
                  }

                  // Override model name (Qoder always returns "auto")
                  if (chunk.model) chunk.model = model;

                  // Track token usage from usage field if present
                  if (chunk.usage) {
                    promptTokens = chunk.usage.prompt_tokens || promptTokens;
                    completionTokens = chunk.usage.completion_tokens || completionTokens;
                  }

                  // Estimate tokens from content
                  const delta = chunk.choices?.[0]?.delta;
                  if (delta?.content) {
                    completionTokens += Math.ceil(delta.content.length / 4);
                  }
                  if (delta?.reasoning_content) {
                    completionTokens += Math.ceil(delta.reasoning_content.length / 4);
                  }

                  // Emit as standard OpenAI SSE
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              } catch (e) {
                // Not valid JSON envelope — pass through as-is
                log.warn(`[Qoder SSE] Parse error: ${String(e).slice(0, 100)}`);
              }
            }
          }
        }
      } catch (e) {
        log.error(`[Qoder SSE] Stream error: ${e}`);
        controller.close();
        usageResolve!({ promptTokens, completionTokens });
      }
    },
    cancel() {
      reader.cancel();
      usageResolve!({ promptTokens, completionTokens });
    },
  });

  const response = new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });

  return { response, usagePromise };
}

/**
 * Convert Qoder SSE response to a single OpenAI non-streaming JSON response.
 */
export async function qoderToOpenAINonStream(
  res: Response,
  model: string,
): Promise<{ response: Response; promptTokens: number; completionTokens: number }> {
  const text = await res.text();
  const lines = text.split("\n");

  let content = "";
  let reasoningContent = "";
  let finishReason = "stop";
  let responseId = "";
  let promptTokens = 0;
  let completionTokens = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) continue;

    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") break;

    try {
      const envelope = JSON.parse(payload);
      if (!envelope.body) continue;

      const chunk = typeof envelope.body === "string"
        ? JSON.parse(envelope.body)
        : envelope.body;

      if (!responseId && chunk.id) responseId = chunk.id;

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) content += delta.content;
      if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;

      if (chunk.choices?.[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }

      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens || promptTokens;
        completionTokens = chunk.usage.completion_tokens || completionTokens;
      }
    } catch {
      continue;
    }
  }

  // Estimate tokens if not provided
  if (!promptTokens) promptTokens = 0;
  if (!completionTokens) completionTokens = Math.ceil((content.length + reasoningContent.length) / 4);

  const responseBody: any = {
    id: responseId || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };

  const response = new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  return { response, promptTokens, completionTokens };
}

/** Helper: process buffered lines */
function processLines(text: string, controller: ReadableStreamDefaultController, model: string) {
  const encoder = new TextEncoder();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return;
    try {
      const envelope = JSON.parse(payload);
      if (envelope.body) {
        const chunk = typeof envelope.body === "string" ? JSON.parse(envelope.body) : envelope.body;
        if (chunk.model) chunk.model = model;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
    } catch {}
  }
}
