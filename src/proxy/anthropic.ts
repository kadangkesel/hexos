/**
 * Translate Anthropic Messages API format → OpenAI chat completions format
 * and translate SSE response back to Anthropic SSE format.
 *
 * Supports:
 *  - text content (plain string and block array)
 *  - tool definitions (tools / tool_choice)
 *  - tool_use content blocks (assistant → tool_calls)
 *  - tool_result content blocks (user  → role:"tool" messages)
 *  - streaming tool_call deltas → content_block_start/delta/stop
 */

import { augmentMessages } from "../utils/transform.ts";

// ---------------------------------------------------------------------------
// Request: Anthropic → OpenAI
// ---------------------------------------------------------------------------

export function anthropicToOpenAI(req: any, model: string): any {
  const messages: any[] = [];

  // System message
  if (req.system) {
    const systemText =
      typeof req.system === "string"
        ? req.system
        : Array.isArray(req.system)
        ? req.system.map((b: any) => b.text ?? "").join("\n")
        : String(req.system);
    messages.push({ role: "system", content: systemText });
  } else {
    messages.push({ role: "system", content: "You are a helpful assistant. Always respond in the same language as the user's message." });
  }

  // Convert messages
  for (const msg of req.messages ?? []) {
    if (msg.role === "assistant") {
      messages.push(...convertAssistantMessage(msg));
    } else if (msg.role === "user") {
      messages.push(...convertUserMessage(msg));
    } else {
      // Passthrough for any other role
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  const body: any = {
    model,
    messages: augmentMessages(messages),
    stream: true,
    max_tokens: req.max_tokens ?? 8192,
    temperature: req.temperature ?? 1,
  };

  // --- tools ---
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    body.tools = req.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }

  // --- tool_choice ---
  if (req.tool_choice) {
    body.tool_choice = convertToolChoice(req.tool_choice);
  }

  return body;
}

/**
 * Convert an Anthropic assistant message (which may contain tool_use blocks)
 * into one or more OpenAI messages.
 */
function convertAssistantMessage(msg: any): any[] {
  if (typeof msg.content === "string") {
    return [{ role: "assistant", content: msg.content }];
  }

  if (!Array.isArray(msg.content)) {
    return [{ role: "assistant", content: "" }];
  }

  const textParts: string[] = [];
  const toolCalls: any[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text ?? "");
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          // OpenAI expects a JSON string, not an object
          arguments:
            typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const oaiMsg: any = { role: "assistant", content: textParts.join("\n") || null };
  if (toolCalls.length > 0) {
    oaiMsg.tool_calls = toolCalls;
  }

  return [oaiMsg];
}

/**
 * Convert an Anthropic user message (which may contain tool_result blocks)
 * into one or more OpenAI messages.
 *
 * OpenAI represents tool results as separate messages with role:"tool".
 */
function convertUserMessage(msg: any): any[] {
  if (typeof msg.content === "string") {
    return [{ role: "user", content: msg.content }];
  }

  if (!Array.isArray(msg.content)) {
    return [{ role: "user", content: "" }];
  }

  const result: any[] = [];
  const textParts: string[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text ?? "");
    } else if (block.type === "tool_result") {
      // Flush any accumulated text first
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
        textParts.length = 0;
      }

      // Tool result content can be a string or an array of blocks
      let content: string;
      if (typeof block.content === "string") {
        content = block.content;
      } else if (Array.isArray(block.content)) {
        content = block.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text ?? "")
          .join("\n");
      } else {
        content = "";
      }

      result.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content,
      });
    }
  }

  // Remaining text
  if (textParts.length > 0) {
    result.push({ role: "user", content: textParts.join("\n") });
  }

  return result.length > 0 ? result : [{ role: "user", content: "" }];
}

/**
 * Convert Anthropic tool_choice to OpenAI tool_choice.
 *
 *  Anthropic                       OpenAI
 *  {type:"auto"}           →       "auto"
 *  {type:"any"}            →       "required"
 *  {type:"none"}           →       "none"
 *  {type:"tool",name:"X"}  →       {type:"function", function:{name:"X"}}
 */
function convertToolChoice(tc: any): any {
  if (!tc) return undefined;
  switch (tc.type) {
    case "auto": return "auto";
    case "any":  return "required";
    case "none": return "none";
    case "tool":
      return { type: "function", function: { name: tc.name } };
    default:
      return "auto";
  }
}

// ---------------------------------------------------------------------------
// Response: OpenAI SSE stream → Anthropic SSE stream
// ---------------------------------------------------------------------------

export function openAIToAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  messageId: string,
  hasThinking: boolean = false
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let buffer = "";
      let headerSent = false;
      let outputTokens = 0;
      let thinkingSent = false;

      // Content block tracking
      let textBlockOpen = false;
      // If thinking requested, text starts at index 1 (thinking = index 0)
      let nextBlockIndex = hasThinking ? 1 : 0;
      const textBlockIndex = hasThinking ? 1 : 0;

      // tool_calls accumulator: index → {id, name, argsBuffer, blockIndex}
      const toolBlocks = new Map<number, {
        id: string;
        name: string;
        argsBuffer: string;
        blockIndex: number;
      }>();

      const send = (event: string, data: any) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      const sendHeader = (inputTokens = 0) => {
        if (headerSent) return;
        headerSent = true;
        send("ping", { type: "ping" });
        send("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        });
      };

      /** Send a fake thinking block if thinking was requested. */
      const ensureThinkingBlock = () => {
        if (!hasThinking || thinkingSent) return;
        thinkingSent = true;
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "..." },
        });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
      };

      /** Open the text content_block if not already open. */
      const ensureTextBlock = () => {
        if (textBlockOpen) return;
        ensureThinkingBlock();
        textBlockOpen = true;
        nextBlockIndex = Math.max(nextBlockIndex, textBlockIndex + 1);
        send("content_block_start", {
          type: "content_block_start",
          index: textBlockIndex,
          content_block: { type: "text", text: "" },
        });
      };

      /** Close the text content_block if it is open. */
      const closeTextBlock = () => {
        if (!textBlockOpen) return;
        textBlockOpen = false;
        send("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
      };

      /**
       * Handle a single OpenAI tool_calls delta chunk.
       * OpenAI sends incremental chunks:
       *   - First chunk for an index has {id, function.name}
       *   - Subsequent chunks have {function.arguments} fragments
       */
      const handleToolCallDelta = (tc: any) => {
        const idx: number = tc.index ?? 0;

        if (!toolBlocks.has(idx)) {
          // First chunk for this tool call
          const blockIndex = nextBlockIndex++;
          toolBlocks.set(idx, {
            id: tc.id ?? `call_${idx}`,
            name: tc.function?.name ?? "",
            argsBuffer: tc.function?.arguments ?? "",
            blockIndex,
          });

          // Close text block before emitting tool blocks
          closeTextBlock();

          const info = toolBlocks.get(idx)!;
          send("content_block_start", {
            type: "content_block_start",
            index: info.blockIndex,
            content_block: {
              type: "tool_use",
              id: info.id,
              name: info.name,
              input: {},
            },
          });
        } else {
          // Subsequent chunk — may update id/name or append arguments
          const info = toolBlocks.get(idx)!;
          if (tc.id) info.id = tc.id;
          if (tc.function?.name) info.name += tc.function.name;
          if (tc.function?.arguments) {
            info.argsBuffer += tc.function.arguments;
            send("content_block_delta", {
              type: "content_block_delta",
              index: info.blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            });
          }
        }
      };

      /** Finalize all open blocks (called on [DONE] or finish_reason). */
      const finalizeBlocks = (stopReason: string) => {
        // Close text block if it was the only thing open
        if (textBlockOpen) closeTextBlock();

        // Close all tool blocks
        for (const [, info] of toolBlocks) {
          send("content_block_stop", {
            type: "content_block_stop",
            index: info.blockIndex,
          });
        }

        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        send("message_stop", { type: "message_stop" });
        controller.close();
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();

            if (raw === "[DONE]") {
              sendHeader();
              // If nothing was opened at all, open+close an empty text block
              if (!textBlockOpen && toolBlocks.size === 0) {
                ensureTextBlock();
              }
              const stopReason = toolBlocks.size > 0 ? "tool_use" : "end_turn";
              finalizeBlocks(stopReason);
              return;
            }

            let chunk: any;
            try { chunk = JSON.parse(raw); } catch { continue; }

            const inputTokens = chunk.usage?.prompt_tokens ?? 0;
            sendHeader(inputTokens);

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;

            // --- Text delta ---
            const textContent = delta?.content ?? "";
            if (textContent) {
              ensureTextBlock();
              outputTokens++;
              send("content_block_delta", {
                type: "content_block_delta",
                index: textBlockIndex,
                delta: { type: "text_delta", text: textContent },
              });
            }

            // --- Tool call deltas ---
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                handleToolCallDelta(tc);
              }
            }

            // --- finish_reason ---
            if (choice.finish_reason === "tool_calls") {
              if (chunk.usage?.completion_tokens) {
                outputTokens = chunk.usage.completion_tokens;
              }
              finalizeBlocks("tool_use");
              return;
            }

            if (choice.finish_reason === "stop") {
              if (chunk.usage?.completion_tokens) {
                outputTokens = chunk.usage.completion_tokens;
              }
              // [DONE] will still come, let it handle close
            }

            if (chunk.usage?.completion_tokens) {
              outputTokens = chunk.usage.completion_tokens;
            }
          }
        }
      } catch (e) {
        controller.error(e);
      }
    },
  });
}
