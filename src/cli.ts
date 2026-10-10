import { createInterface } from "node:readline/promises";
import { main } from "./main.js";
import { spawnCapturer, spawnRunner } from "./run.js";
import { postgresSession } from "./sql.js";

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
      }
    : {}),
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
