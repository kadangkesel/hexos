/**
 * AWS EventStream binary parser + Kiro → OpenAI SSE converter.
 *
 * Kiro (AWS CodeWhisperer) returns responses in AWS EventStream binary
 * framing format, NOT standard SSE/JSON. This module:
 *
 * 1. Parses the binary EventStream frames
 * 2. Converts Kiro events to OpenAI-compatible SSE chunks
 * 3. Returns a ReadableStream that emits SSE text
 *
 * EventStream frame structure:
 *   [4 bytes] total_length (big-endian uint32)
 *   [4 bytes] headers_length (big-endian uint32)
 *   [4 bytes] prelude_crc (CRC32)
 *   [N bytes] headers (key-value pairs)
 *   [M bytes] payload (JSON)
 *   [4 bytes] message_crc (CRC32)
 *
 * Kiro event types:
 *   - assistantResponseEvent: text content chunk
 *   - codeEvent: code content chunk
 *   - toolUseEvent: tool call
 *   - messageStopEvent: end of response
 *   - metricsEvent: token usage (inputTokens, outputTokens)
 *   - contextUsageEvent: context window % used
 *   - reasoningContentEvent: thinking/reasoning text
 */

const uuidv4 = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// EventStream binary parser
// ---------------------------------------------------------------------------

interface EventStreamFrame {
  eventType: string;
  payload: Record<string, any>;
}

/**
 * Parse a single EventStream frame from a buffer.
 * Returns the frame and the number of bytes consumed, or null if incomplete.
 */
function parseFrame(buf: Uint8Array, offset: number): { frame: EventStreamFrame; bytesConsumed: number } | null {
  if (offset + 4 > buf.length) return null;

  const view = new DataView(buf.buffer, buf.byteOffset + offset);
  const totalLength = view.getUint32(0);

  if (totalLength < 16) return null;
  if (offset + totalLength > buf.length) return null; // incomplete frame

  const headersLength = view.getUint32(4);
  // Skip prelude CRC (bytes 8-11)

  // Parse headers
  const headersStart = 12;
  const headersEnd = headersStart + headersLength;
  const headers: Record<string, string> = {};

  let hPos = headersStart;
  while (hPos < headersEnd) {
    if (hPos + 1 > buf.length) break;
    const nameLen = buf[offset + hPos];
    hPos += 1;

    if (hPos + nameLen > headersEnd) break;
    const name = new TextDecoder().decode(buf.slice(offset + hPos, offset + hPos + nameLen));
    hPos += nameLen;

    if (hPos + 1 > headersEnd) break;
    const valueType = buf[offset + hPos];
    hPos += 1;

    if (valueType === 7) {
      // String type
      if (hPos + 2 > headersEnd) break;
      const valueLen = new DataView(buf.buffer, buf.byteOffset + offset + hPos).getUint16(0);
      hPos += 2;

      if (hPos + valueLen > headersEnd) break;
      const value = new TextDecoder().decode(buf.slice(offset + hPos, offset + hPos + valueLen));
      hPos += valueLen;

      headers[name] = value;
    } else {
      // Unknown type, can't continue parsing headers
      break;
    }
  }

  // Parse payload (between headers end and message CRC)
  const payloadStart = headersEnd;
  const payloadEnd = totalLength - 4; // exclude message CRC
  const payloadBytes = buf.slice(offset + payloadStart, offset + payloadEnd);

  let payload: Record<string, any> = {};
  if (payloadBytes.length > 0) {
    try {
      payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch {
      payload = { raw: new TextDecoder("utf-8", { fatal: false }).decode(payloadBytes) };
    }
  }

  return {
    frame: {
      eventType: headers[":event-type"] || headers[":exception-type"] || "unknown",
      payload,
    },
    bytesConsumed: totalLength,
  };
}

/**
 * Parse all EventStream frames from a buffer.
 * Returns parsed frames and any remaining bytes (incomplete frame).
 */
function parseFrames(buf: Uint8Array): { frames: EventStreamFrame[]; remaining: Uint8Array } {
  const frames: EventStreamFrame[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const result = parseFrame(buf, offset);
    if (!result) break;
    frames.push(result.frame);
    offset += result.bytesConsumed;
  }

  return {
    frames,
    remaining: buf.slice(offset),
  };
}

// ---------------------------------------------------------------------------
// Kiro → OpenAI SSE converter
// ---------------------------------------------------------------------------

/**
 * Convert a Kiro EventStream binary response to an OpenAI-compatible SSE stream.
 *
 * @param kiroResponse - The raw Response from Kiro API
 * @param model - The model ID to include in SSE chunks
 * @returns A new Response with SSE body + usage metadata headers
 */
export function kiroToOpenAIStream(
  kiroResponse: Response,
  model: string,
): { response: Response; usagePromise: Promise<{ promptTokens: number; completionTokens: number }> } {
  const chatId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  let inputTokens = 0;
  let outputTokens = 0;
  let resolveUsage: (v: { promptTokens: number; completionTokens: number }) => void;
  const usagePromise = new Promise<{ promptTokens: number; completionTokens: number }>((resolve) => {
    resolveUsage = resolve;
  });

  // Accumulate tool call state
  const pendingToolCalls: Map<string, { id: string; name: string; input: string }> = new Map();

  const encoder = new TextEncoder();

  function sseChunk(data: any): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  }

  function makeChunk(delta: any, finishReason: string | null = null): any {
    return {
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    };
  }

  const readable = new ReadableStream({
    async start(controller) {
      // Send initial chunk with role
      controller.enqueue(sseChunk(makeChunk({ role: "assistant", content: "" })));

      const body = kiroResponse.body;
      if (!body) {
        controller.enqueue(sseChunk(makeChunk({}, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        resolveUsage!({ promptTokens: 0, completionTokens: 0 });
        return;
      }

      const reader = body.getReader();
      let remaining = new Uint8Array(0);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Concatenate with remaining bytes from previous iteration
          const combined = new Uint8Array(remaining.length + value.length);
          combined.set(remaining);
          combined.set(value, remaining.length);

          const { frames, remaining: leftover } = parseFrames(combined);
          remaining = leftover;

          for (const frame of frames) {
            const { eventType, payload } = frame;

            switch (eventType) {
              case "assistantResponseEvent":
              case "codeEvent": {
                const content = payload.content ?? "";
                if (content) {
                  controller.enqueue(sseChunk(makeChunk({ content })));
                }
                break;
              }

              case "reasoningContentEvent": {
                // Thinking/reasoning — emit as content (some clients handle this)
                const content = payload.content ?? "";
                if (content) {
                  controller.enqueue(sseChunk(makeChunk({ content })));
                }
                break;
              }

              case "toolUseEvent": {
                // Tool call from Kiro
                const toolUseId = payload.toolUseId ?? uuidv4();
                const name = payload.name ?? "";
                const input = typeof payload.input === "string"
                  ? payload.input
                  : JSON.stringify(payload.input ?? {});

                // Emit as OpenAI tool_calls delta
                controller.enqueue(sseChunk(makeChunk({
                  tool_calls: [{
                    index: 0,
                    id: toolUseId,
                    type: "function",
                    function: { name, arguments: input },
                  }],
                })));
                break;
              }

              case "metricsEvent":
              case "usageEvent": {
                inputTokens = payload.inputTokens ?? payload.input_tokens ?? inputTokens;
                outputTokens = payload.outputTokens ?? payload.output_tokens ?? outputTokens;
                break;
              }

              case "contextUsageEvent": {
                // Estimate tokens from context usage percentage if no metrics event
                const pct = payload.contextUsagePercentage ?? 0;
                if (pct > 0 && inputTokens === 0) {
                  inputTokens = Math.round((pct / 100) * 200000);
                }
                break;
              }

              case "messageStopEvent": {
                const stopReason = payload.stopReason ?? "end_turn";
                const finishReason = stopReason === "tool_use" ? "tool_calls" : "stop";
                controller.enqueue(sseChunk(makeChunk({}, finishReason)));
                break;
              }

              // Ignore: meteringEvent, supplementaryWebLinksEvent, etc.
              default:
                break;
            }
          }
        }
      } catch (err) {
        // Stream error — close gracefully
      }

      // Estimate output tokens from content if metricsEvent was not received
      if (outputTokens === 0) {
        // Rough estimate: ~4 chars per token
        // We don't have the full content here, so leave as 0
      }

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
      resolveUsage!({ promptTokens: inputTokens, completionTokens: outputTokens });
    },
  });

  const response = new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Transfer-Encoding": "chunked",
    },
  });

  return { response, usagePromise };
}

/**
 * Convert a Kiro EventStream binary response to a non-streaming OpenAI response.
 * Reads the entire response, parses all frames, and returns a single JSON response.
 */
export async function kiroToOpenAINonStream(
  kiroResponse: Response,
  model: string,
): Promise<{ response: Response; promptTokens: number; completionTokens: number }> {
  const chatId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // Read entire response body
  const raw = new Uint8Array(await kiroResponse.arrayBuffer());
  const { frames } = parseFrames(raw);

  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = "stop";
  const toolCalls: any[] = [];

  for (const frame of frames) {
    const { eventType, payload } = frame;

    switch (eventType) {
      case "assistantResponseEvent":
      case "codeEvent":
      case "reasoningContentEvent":
        content += payload.content ?? "";
        break;

      case "toolUseEvent": {
        const input = typeof payload.input === "string"
          ? payload.input
          : JSON.stringify(payload.input ?? {});
        toolCalls.push({
          id: payload.toolUseId ?? uuidv4(),
          type: "function",
          function: { name: payload.name ?? "", arguments: input },
        });
        break;
      }

      case "metricsEvent":
      case "usageEvent":
        inputTokens = payload.inputTokens ?? payload.input_tokens ?? inputTokens;
        outputTokens = payload.outputTokens ?? payload.output_tokens ?? outputTokens;
        break;

      case "contextUsageEvent": {
        const pct = payload.contextUsagePercentage ?? 0;
        if (pct > 0 && inputTokens === 0) {
          inputTokens = Math.round((pct / 100) * 200000);
        }
        break;
      }

      case "messageStopEvent":
        finishReason = (payload.stopReason === "tool_use") ? "tool_calls" : "stop";
        break;
    }
  }

  // Estimate output tokens if not provided
  if (outputTokens === 0 && content) {
    outputTokens = Math.ceil(content.length / 4);
  }

  const message: any = {
    role: "assistant",
    content: content || null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const responseBody = {
    id: chatId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };

  const response = new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  return { response, promptTokens: inputTokens, completionTokens: outputTokens };
}
