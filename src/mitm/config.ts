/** All intercepted domains — these get redirected via /etc/hosts */
export const TARGET_HOSTS: string[] = [
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];

/** Per-tool DNS host mapping */
export const TOOL_HOSTS: Record<string, string[]> = {
  antigravity: ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"],
  copilot: ["api.individual.githubcopilot.com"],
  kiro: ["q.us-east-1.amazonaws.com", "codewhisperer.us-east-1.amazonaws.com"],
  cursor: ["api2.cursor.sh"],
};

/** URL patterns that indicate a chat/completion request per tool */
export const URL_PATTERNS: Record<string, string[]> = {
  antigravity: [":generateContent", ":streamGenerateContent"],
  copilot: ["/chat/completions", "/v1/messages", "/responses"],
  kiro: ["/generateAssistantResponse"],
  cursor: ["/BidiAppend", "/RunSSE", "/RunPoll", "/Run"],
};

/** Anti-loop header — prevents MITM from intercepting Hexos's own upstream requests */
export const INTERNAL_REQUEST_HEADER = {
  name: "x-request-source",
  value: "local",
} as const;

/** Determine which tool a request belongs to based on Host header */
export function getToolForHost(host: string | undefined): string | null {
  const h = (host || "").split(":")[0];
  if (h === "api.individual.githubcopilot.com") return "copilot";
  if (h === "daily-cloudcode-pa.googleapis.com" || h === "cloudcode-pa.googleapis.com") return "antigravity";
  if (h === "q.us-east-1.amazonaws.com" || h === "codewhisperer.us-east-1.amazonaws.com") return "kiro";
  if (h === "api2.cursor.sh") return "cursor";
  return null;
}
