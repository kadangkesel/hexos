import chalk from "chalk";

const ts = () => {
  const d = new Date();
  return chalk.gray(`[${d.toTimeString().slice(0, 8)}]`);
};

type LogListener = (level: "info" | "success" | "error", message: string) => void;
const listeners: Set<LogListener> = new Set();

function notify(level: "info" | "success" | "error", msg: string) {
  for (const fn of listeners) {
    try { fn(level, msg); } catch {}
  }
}

export const log = {
  info: (msg: string) => { console.log(`${ts()} ${chalk.cyan("ℹ")} ${msg}`); notify("info", msg); },
  ok: (msg: string) => { console.log(`${ts()} ${chalk.green("✓")} ${msg}`); notify("success", msg); },
  warn: (msg: string) => { console.log(`${ts()} ${chalk.yellow("⚠")} ${msg}`); notify("error", msg); },
  error: (msg: string) => { console.log(`${ts()} ${chalk.red("✗")} ${msg}`); notify("error", msg); },
  req: (method: string, path: string, extra = "") =>
    console.log(`${ts()} ${chalk.magenta(method)} ${chalk.white(path)} ${chalk.gray(extra)}`),
  addListener: (fn: LogListener) => { listeners.add(fn); },
  removeListener: (fn: LogListener) => { listeners.delete(fn); },
};
