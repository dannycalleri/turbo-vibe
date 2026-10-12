import { expect, it } from "vitest";
import { spawnCapturer } from "../../src/run.js";

it("gives a child process its input on stdin", async () => {
  const result = await spawnCapturer(
    process.execPath,
    [
      "-e",
      "let n = 0; process.stdin.on('data', (c) => { n += c.length; }).on('end', () => console.log(n));",
    ],
    { cwd: process.cwd(), env: process.env, input: "s3cr3t" },
  );
  expect(result).toEqual({ code: 0, stdout: "6\n" });
});
