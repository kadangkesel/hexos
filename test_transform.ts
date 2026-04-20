import { augmentMessages } from "./src/utils/transform.ts";

const system = ": cc_version=2.1.114.abc; cc_entrypoint=sdk-cli; cch=12345;\nYou are Assistant Code, Anthropic's official CLI for Assistant.\nYou are pair programming with a USER to solve their coding task.";

const messages = [
  { role: "system", content: system },
  { role: "user", content: "hello" }
];

const result = augmentMessages(messages);
for (const msg of result) {
  console.log(`--- ${msg.role} ---`);
  console.log(JSON.stringify(msg.content).slice(0, 500));
}
