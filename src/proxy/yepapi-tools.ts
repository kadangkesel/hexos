/**
 * YepAPI Tool Call Emulation
 *
 * YepAPI doesn't natively support OpenAI function calling (tools).
 * This module emulates it by:
 *   1. Injecting tool definitions into the system prompt as XML
 *   2. Parsing <tool_call> blocks from the model's response
 *   3. Transforming them into OpenAI-compatible tool_calls format
 *   4. Handling both streaming and non-streaming responses
 *   5. Converting role:"tool" messages back to text for the next turn
 */

// ---------------------------------------------------------------------------
// Regex for extracting <tool_call>...</tool_call> blocks
// ---------------------------------------------------------------------------

const TOOL_CALL_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

function generateCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, "")}`;
}

// ---------------------------------------------------------------------------
// Tool call extraction helpers
// ---------------------------------------------------------------------------

interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Extract all valid tool calls from text content.
 * Returns parsed tool calls and the remaining text (content outside tool_call blocks).
 */
function extractToolCalls(content: string): {
  toolCalls: ParsedToolCall[];
  remainingText: string;
} {
  const toolCalls: ParsedToolCall[] = [];
  let remainingText = content;

  // Collect all matches first
  const matches: { fullMatch: string; json: string }[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(TOOL_CALL_REGEX.source, TOOL_CALL_REGEX.flags);

  while ((match = regex.exec(content)) !== null) {
    matches.push({ fullMatch: match[0], json: match[1] });
  }

  for (const { fullMatch, json } of matches) {
    const trimmed = json.trim();
    if (!trimmed) {
      // Empty tool_call block — remove from text but skip
      remainingText = remainingText.replace(fullMatch, "");
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.name === "string") {
        toolCalls.push({
          name: parsed.name,
          arguments: parsed.arguments ?? {},
        });
        // Remove this tool_call block from remaining text
        remainingText = remainingText.replace(fullMatch, "");
      }
    } catch {
      // Malformed JSON — leave in text as-is (treat as regular content)
    }
  }

  // Clean up remaining text: trim and collapse multiple blank lines
  remainingText = remainingText.replace(/\n{3,}/g, "\n\n").trim();

  return { toolCalls, remainingText };
}

// ---------------------------------------------------------------------------
// injectToolsIntoMessages
// ---------------------------------------------------------------------------

/**
 * Inject tool definitions into the request body's messages as a system prompt.
 * Converts role:"tool" messages to role:"user" with XML wrapper.
 * Removes `tools` and `tool_choice` from the body so YepAPI doesn't see them.
 *
 * Returns a new body object (does not mutate the original).
 */
export function injectToolsIntoMessages(body: any): any {
  if (!body.tools || !Array.isArray(body.tools) || body.tools.length === 0) {
    return body;
  }

  const newBody = { ...body };
  const messages: any[] = [...(newBody.messages || [])];

  // Build the tool injection prompt
  const toolsJson = JSON.stringify(body.tools, null, 2);
  let toolPrompt = `You have access to the following tools:
<tools>
${toolsJson}
</tools>

When you need to call a tool, respond ONLY with one or more tool call blocks:
<tool_call>
{"name": "function_name", "arguments": {"arg": "value"}}
</tool_call>

If you don't need any tools, respond normally without any <tool_call> tags.`;

  // Handle tool_choice
  if (body.tool_choice === "required") {
    toolPrompt += "\n\nYou MUST call at least one tool.";
  } else if (
    body.tool_choice &&
    typeof body.tool_choice === "object" &&
    body.tool_choice.function?.name
  ) {
    toolPrompt += `\n\nYou MUST call the ${body.tool_choice.function.name} tool.`;
  }

  // Find the first system message and prepend tool prompt
  let systemFound = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system" || msg.role === "developer") {
      const existingContent =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n")
            : "";
      messages[i] = {
        ...msg,
        role: "system",
        content: toolPrompt + "\n\n" + existingContent,
      };
      systemFound = true;
      break;
    }
  }

  if (!systemFound) {
    // No system message exists — create one at the beginning
    messages.unshift({ role: "system", content: toolPrompt });
  }

  // Convert role:"tool" messages to role:"user" with XML wrapper
  // Also convert assistant messages with tool_calls to show what was called
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // Convert assistant tool_calls back to <tool_call> text format
      let content = msg.content || "";
      for (const tc of msg.tool_calls) {
        if (tc.function?.name) {
          const args = tc.function.arguments
            ? typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments)
            : "{}";
          content += `\n<tool_call>\n{"name": "${tc.function.name}", "arguments": ${args}}\n</tool_call>`;
        }
      }
      messages[i] = {
        role: "assistant",
        content: content.trim(),
      };
    } else if (msg.role === "tool") {
      const toolName = msg.name || msg.tool_call_id || "unknown";
      const toolContent =
        typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      messages[i] = {
        role: "user",
        content: `<tool_result name="${toolName}">\n${toolContent}\n</tool_result>`,
      };
    }
  }

  newBody.messages = messages;

  // Remove tools and tool_choice so YepAPI doesn't see them
  delete newBody.tools;
  delete newBody.tool_choice;

  return newBody;
}

// ---------------------------------------------------------------------------
// parseToolCallsFromResponse (non-streaming)
// ---------------------------------------------------------------------------

/**
 * Parse a non-streaming response JSON, extract <tool_call> blocks from the
 * assistant's content, and transform into OpenAI tool_calls format.
 *
 * If no <tool_call> blocks are found, returns the response unchanged.
 */
export function parseToolCallsFromResponse(responseJson: any): any {
  if (
    !responseJson?.choices?.[0]?.message?.content ||
    typeof responseJson.choices[0].message.content !== "string"
  ) {
    return responseJson;
  }

  const content = responseJson.choices[0].message.content;

  // Quick check — no tool_call tags at all
  if (!content.includes("<tool_call>")) {
    return responseJson;
  }

  const { toolCalls, remainingText } = extractToolCalls(content);

  if (toolCalls.length === 0) {
    // All tool_call blocks were malformed — return as-is
    return responseJson;
  }

  // Build OpenAI tool_calls array
  const openaiToolCalls = toolCalls.map((tc) => ({
    id: generateCallId(),
    type: "function" as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
    },
  }));

  // Build the modified response
  const newResponse = { ...responseJson };
  newResponse.choices = [...responseJson.choices];
  newResponse.choices[0] = { ...responseJson.choices[0] };
  newResponse.choices[0].message = {
    ...responseJson.choices[0].message,
    role: "assistant",
    content: remainingText || null,
    tool_calls: openaiToolCalls,
  };
  newResponse.choices[0].finish_reason = "tool_calls";

  return newResponse;
}

// ---------------------------------------------------------------------------
// createYepApiToolCallTransformer (streaming)
// ---------------------------------------------------------------------------

/**
 * Create a TransformStream that buffers SSE chunks from YepAPI, detects
 * <tool_call> blocks in the accumulated content, and emits proper OpenAI
 * tool_calls SSE format.
 *
 * The stream buffers ALL chunks until [DONE] is received, then:
 * - If tool_calls detected: emits tool_calls delta SSE chunks
 * - If no tool_calls: replays all buffered chunks as-is
 */
export function createYepApiToolCallTransformer(
  requestId: string,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Buffer state
  let sseBuffer = ""; // Raw SSE text buffer for line parsing
  const bufferedChunks: Uint8Array[] = []; // All raw chunks for replay
  let accumulatedContent = ""; // Full content text assembled from deltas
  let model = ""; // Model from first chunk
  let chunkId = `chatcmpl-${requestId}`;

  return new TransformStream({
    transform(chunk, _controller) {
      // Buffer everything — don't emit yet
      bufferedChunks.push(new Uint8Array(chunk));

      // Parse SSE lines to accumulate content
      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split("\n");
      // Keep the last potentially incomplete line
      sseBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === "[DONE]") continue;

        try {
          const data = JSON.parse(dataStr);
          if (!model && data.model) model = data.model;
          if (!chunkId && data.id) chunkId = data.id;

          // Extract content delta
          const delta = data.choices?.[0]?.delta;
          if (delta?.content) {
            accumulatedContent += delta.content;
          }
        } catch {
          // Skip unparseable lines
        }
      }
    },

    flush(controller) {
      // Process any remaining buffer text
      if (sseBuffer.trim()) {
        const lines = sseBuffer.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === "[DONE]") continue;

          try {
            const data = JSON.parse(dataStr);
            if (!model && data.model) model = data.model;
            const delta = data.choices?.[0]?.delta;
            if (delta?.content) {
              accumulatedContent += delta.content;
            }
          } catch {
            // Skip
          }
        }
      }

      const created = Math.floor(Date.now() / 1000);

      // Check if accumulated content contains tool calls
      if (!accumulatedContent.includes("<tool_call>")) {
        // No tool calls — replay all buffered chunks as-is
        for (const chunk of bufferedChunks) {
          controller.enqueue(chunk);
        }
        return;
      }

      const { toolCalls, remainingText } = extractToolCalls(accumulatedContent);

      if (toolCalls.length === 0) {
        // All tool_call blocks were malformed — replay as-is
        for (const chunk of bufferedChunks) {
          controller.enqueue(chunk);
        }
        return;
      }

      // Emit tool_calls in OpenAI streaming format

      // First, if there's remaining text content, emit it as content chunks
      if (remainingText) {
        const textChunk = {
          id: chunkId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: remainingText },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk)}\n\n`));
      }

      // Emit each tool call
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const callId = generateCallId();
        const argsStr = JSON.stringify(tc.arguments);

        // First chunk: tool call header with id, type, function name
        const headerChunk = {
          id: chunkId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: i,
                    id: callId,
                    type: "function",
                    function: { name: tc.name, arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(headerChunk)}\n\n`));

        // Second chunk: arguments
        const argsChunk = {
          id: chunkId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: i,
                    function: { arguments: argsStr },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(argsChunk)}\n\n`));
      }

      // Final chunk: finish_reason = "tool_calls"
      const finishChunk = {
        id: chunkId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "tool_calls",
          },
        ],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));

      // [DONE]
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}
