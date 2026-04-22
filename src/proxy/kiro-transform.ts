/**
 * OpenAI → Kiro request format converter.
 *
 * Kiro uses AWS CodeWhisperer API which has a completely different
 * request format from OpenAI. This module converts OpenAI-style
 * chat completion requests into Kiro's native format.
 *
 * Key differences:
 * - system/tool roles → merged into user messages
 * - History must alternate user/assistant
 * - Last user message → currentMessage, rest → history
 * - Tools go in userInputMessageContext
 * - Tool results go in userInputMessageContext.toolResults
 * - Images: base64 only (in userInputMessage.images)
 */

const uuidv4 = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  name?: string;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

interface KiroRequest {
  conversationState: {
    chatTriggerType: string;
    conversationId: string;
    currentMessage: {
      userInputMessage: {
        content: string;
        modelId: string;
        origin: string;
        userInputMessageContext?: {
          tools?: Array<{
            toolSpecification: {
              name: string;
              description: string;
              inputSchema: { json: Record<string, any> };
            };
          }>;
          toolResults?: Array<{
            toolUseId: string;
            status: string;
            content: Array<{ text: string }>;
          }>;
        };
        images?: Array<{
          format: string;
          source: { bytes: string };
        }>;
      };
    };
    history: Array<
      | { userInputMessage: { content: string; modelId: string } }
      | { assistantResponseMessage: { content: string; toolUses?: any[] } }
    >;
  };
  profileArn: string;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  };
}

// ---------------------------------------------------------------------------
// Converter
// ---------------------------------------------------------------------------

/**
 * Convert OpenAI chat completion request to Kiro format.
 */
export function openaiToKiro(
  body: any,
  modelId: string,
  profileArn: string,
): KiroRequest {
  const messages: OpenAIMessage[] = body.messages ?? [];
  const tools: OpenAITool[] = body.tools ?? [];
  const maxTokens = body.max_tokens ?? 32000;
  const temperature = body.temperature;
  const topP = body.top_p;

  // Step 1: Flatten messages — merge system into user, extract tool results
  const flattened = flattenMessages(messages);

  // Step 2: Ensure alternating user/assistant pattern
  const alternating = ensureAlternating(flattened);

  // Step 3: Split into history + currentMessage
  const { history, current } = splitHistoryAndCurrent(alternating, modelId);

  // Step 4: Build tools for currentMessage
  const kiroTools = tools.length > 0 ? convertTools(tools) : undefined;

  // Step 5: Extract tool results from current message context
  const toolResults = extractToolResults(messages);

  // Step 6: Extract images from current message
  const images = extractImages(messages);

  // Step 7: Build context
  const userInputMessageContext: any = {};
  if (kiroTools) userInputMessageContext.tools = kiroTools;
  if (toolResults.length > 0) userInputMessageContext.toolResults = toolResults;

  // Step 8: Build current message with time context
  const ts = new Date().toISOString();
  const currentContent = `[Context: Current time is ${ts}]\n\n${current}`;

  const currentMessage: any = {
    userInputMessage: {
      content: currentContent,
      modelId,
      origin: "AI_EDITOR",
    },
  };

  if (Object.keys(userInputMessageContext).length > 0) {
    currentMessage.userInputMessage.userInputMessageContext = userInputMessageContext;
  }
  if (images.length > 0) {
    currentMessage.userInputMessage.images = images;
  }

  // Step 9: Build full request
  const request: KiroRequest = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: uuidv4(),
      currentMessage,
      history,
    },
    profileArn: profileArn || "arn:aws:codewhisperer:us-east-1:63861613270:profile/AAACCXX",
  };

  const inferenceConfig: any = {};
  if (maxTokens) inferenceConfig.maxTokens = Math.min(maxTokens, 32000);
  if (temperature !== undefined) inferenceConfig.temperature = temperature;
  if (topP !== undefined) inferenceConfig.topP = topP;
  if (Object.keys(inferenceConfig).length > 0) {
    request.inferenceConfig = inferenceConfig;
  }

  return request;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface FlatMessage {
  role: "user" | "assistant";
  content: string;
  toolUses?: any[];
}

function flattenMessages(messages: OpenAIMessage[]): FlatMessage[] {
  const result: FlatMessage[] = [];

  for (const msg of messages) {
    const content = extractTextContent(msg.content);

    if (msg.role === "system") {
      // System → user
      if (content) result.push({ role: "user", content });
    } else if (msg.role === "tool") {
      // Tool result → user (will be handled as toolResults in context)
      if (content) result.push({ role: "user", content: `[Tool Result: ${msg.tool_call_id || "unknown"}]\n${content}` });
    } else if (msg.role === "assistant") {
      const flat: FlatMessage = { role: "assistant", content };
      // Convert tool_calls to Kiro toolUses
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        flat.toolUses = msg.tool_calls.map((tc) => ({
          toolUseId: tc.id,
          name: tc.function.name,
          input: safeParseJSON(tc.function.arguments),
        }));
      }
      result.push(flat);
    } else {
      // user
      result.push({ role: "user", content });
    }
  }

  return result;
}

function ensureAlternating(messages: FlatMessage[]): FlatMessage[] {
  if (messages.length === 0) return [];

  const result: FlatMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    if (prev.role === curr.role) {
      // Merge consecutive same-role messages
      prev.content = prev.content + "\n\n" + curr.content;
      if (curr.toolUses) {
        prev.toolUses = [...(prev.toolUses || []), ...curr.toolUses];
      }
    } else {
      result.push(curr);
    }
  }

  // Ensure starts with user
  if (result.length > 0 && result[0].role !== "user") {
    result.unshift({ role: "user", content: "(conversation start)" });
  }

  // Ensure ends with user (for currentMessage)
  if (result.length > 0 && result[result.length - 1].role !== "user") {
    result.push({ role: "user", content: "(awaiting response)" });
  }

  return result;
}

function splitHistoryAndCurrent(
  messages: FlatMessage[],
  modelId: string,
): { history: any[]; current: string } {
  if (messages.length === 0) {
    return { history: [], current: "" };
  }

  // Last message is currentMessage
  const current = messages[messages.length - 1].content;

  // Everything else is history
  const history: any[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      history.push({
        userInputMessage: {
          content: msg.content,
          modelId,
        },
      });
    } else {
      const assistantMsg: any = {
        assistantResponseMessage: {
          content: msg.content,
        },
      };
      if (msg.toolUses && msg.toolUses.length > 0) {
        assistantMsg.assistantResponseMessage.toolUses = msg.toolUses;
      }
      history.push(assistantMsg);
    }
  }

  return { history, current };
}

function convertTools(tools: OpenAITool[]): any[] {
  return tools.map((tool) => ({
    toolSpecification: {
      name: tool.function.name,
      description: tool.function.description || "",
      inputSchema: {
        json: tool.function.parameters || { type: "object", properties: {}, required: [] },
      },
    },
  }));
}

function extractToolResults(messages: OpenAIMessage[]): any[] {
  const results: any[] = [];
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      results.push({
        toolUseId: msg.tool_call_id,
        status: "success",
        content: [{ text: extractTextContent(msg.content) }],
      });
    }
  }
  return results;
}

function extractImages(messages: OpenAIMessage[]): any[] {
  const images: any[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "image_url" && part.image_url?.url) {
        const url = part.image_url.url;
        // Only base64 data URIs supported
        const match = url.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/);
        if (match) {
          images.push({
            format: match[1],
            source: { bytes: match[2] },
          });
        }
      }
    }
  }
  return images;
}

function extractTextContent(content: string | Array<any>): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
  }
  return String(content ?? "");
}

function safeParseJSON(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
