#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { main } from "./main.js";
import { clackPrompts } from "./prompts.js";
import { spawnCapturer, spawnRunner } from "./run.js";
import { postgresSession } from "./sql.js";

function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          finish();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          finish();
          process.exit(130);
        }
        value = char === "\u007f" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
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
        ask: async (question: string) => {
          const prompt = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          try {
            return await prompt.question(`${question}: `);
          } finally {
            prompt.close();
          }
        },
        askSecret: (question: string) => readHidden(`${question}: `),
        prompts: clackPrompts,
      }
    : {}),
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
