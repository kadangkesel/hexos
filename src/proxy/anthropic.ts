/**
 * Translate Anthropic Messages API format → OpenAI chat completions format
 * and translate SSE response back to Anthropic SSE format.
 */

// Anthropic request → OpenAI body
export function anthropicToOpenAI(req: any, model: string): any {
  const messages: any[] = [];

  // System message
  if (req.system) {
    const systemText = typeof req.system === "string"
      ? req.system
      : Array.isArray(req.system)
        ? req.system.map((b: any) => b.text ?? "").join("\n")
        : String(req.system);
    messages.push({ role: "system", content: systemText });
  } else {
    messages.push({ role: "system", content: "You are a helpful assistant." });
  }

  // Convert messages
  for (const msg of req.messages ?? []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      messages.push({ role: msg.role, content: text || " " });
    }
  }

  return {
    model,
    messages,
    stream: true,
    max_tokens: req.max_tokens ?? 8192,
    temperature: req.temperature ?? 1,
  };
}

// Transform OpenAI SSE stream → Anthropic SSE stream
export function openAIToAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  messageId: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let buffer = "";
      let headerSent = false;
      let outputTokens = 0;

      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const sendHeader = (inputTokens = 0) => {
        if (headerSent) return;
        headerSent = true;
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
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        send("ping", { type: "ping" });
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
              sendHeader(); // ensure header sent even if no content
              send("content_block_stop", { type: "content_block_stop", index: 0 });
              send("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: outputTokens },
              });
              send("message_stop", { type: "message_stop" });
              controller.close();
              return;
            }

            let chunk: any;
            try { chunk = JSON.parse(raw); } catch { continue; }

            const inputTokens = chunk.usage?.prompt_tokens ?? 0;
            sendHeader(inputTokens);

            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            const content = delta.content ?? "";
            if (content) {
              outputTokens++;
              send("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: content },
              });
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
