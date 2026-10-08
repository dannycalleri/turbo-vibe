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
  options: { cwd: string; env: Readonly<Record<string, string | undefined>> },
) => Promise<{ code: number; stdout: string }>;

export const spawnCapturer: Capturer = (command, args, { cwd, env }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
