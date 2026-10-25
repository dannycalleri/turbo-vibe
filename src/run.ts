import { spawn } from "node:child_process";

export type Runner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Readonly<Record<string, string | undefined>> },
) => Promise<number>;

export const spawnRunner: Runner = (command, args, { cwd, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

export type Capturer = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Readonly<Record<string, string | undefined>>;
    input?: string;
    quiet?: boolean;
  },
) => Promise<{ code: number; stdout: string; stderr?: string }>;

export const spawnCapturer: Capturer = (
  command,
  args,
  { cwd, env, input, quiet },
) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [
        input === undefined ? "ignore" : "pipe",
        "pipe",
        quiet ? "pipe" : "inherit",
      ],
    });
    if (input !== undefined) child.stdin?.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout, ...(quiet ? { stderr } : {}) }),
    );
  });
