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
