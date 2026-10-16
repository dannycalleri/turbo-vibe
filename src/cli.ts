#!/usr/bin/env node
import { main } from "./main.js";
import { askHidden, askLine, clackPrompts } from "./prompts.js";
import { spawnCapturer, spawnRunner } from "./run.js";
import { postgresSession } from "./sql.js";

function cancelled(): never {
  process.stderr.write("cancelled\n");
  process.exit(130);
}

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  run: spawnRunner,
  capture: spawnCapturer,
  sql: postgresSession,
  ...(process.stdin.isTTY
    ? {
        ask: async (question: string) =>
          (await askLine(question)) ?? cancelled(),
        askSecret: async (question: string) =>
          (await askHidden(question)) ?? cancelled(),
        prompts: clackPrompts,
      }
    : {}),
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
