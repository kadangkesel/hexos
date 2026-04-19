import { randomBytes } from "crypto";

export function generateApiKey(): string {
  return "hx-" + randomBytes(24).toString("hex");
}

export function hashKey(key: string): string {
  return Bun.hash(key).toString(16);
}
