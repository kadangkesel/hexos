import chalk from "chalk";

const ts = () => {
  const d = new Date();
  return chalk.gray(`[${d.toTimeString().slice(0, 8)}]`);
};

export const log = {
  info: (msg: string) => console.log(`${ts()} ${chalk.cyan("ℹ")} ${msg}`),
  ok: (msg: string) => console.log(`${ts()} ${chalk.green("✓")} ${msg}`),
  warn: (msg: string) => console.log(`${ts()} ${chalk.yellow("⚠")} ${msg}`),
  error: (msg: string) => console.log(`${ts()} ${chalk.red("✗")} ${msg}`),
  req: (method: string, path: string, extra = "") =>
    console.log(`${ts()} ${chalk.magenta(method)} ${chalk.white(path)} ${chalk.gray(extra)}`),
};
