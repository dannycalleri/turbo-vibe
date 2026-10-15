import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { spawnCapturer, spawnRunner } from "../../src/run.js";
import { postgresSession } from "../../src/sql.js";

const pythonApp = new URL("../../examples/python-api/app.py", import.meta.url)
  .pathname;

describe("a backend's build secret", () => {
  it("reaches a BuildKit secret mount, and no image layer keeps it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-build-secret-"));
    await copyFile(pythonApp, join(dir, "app.py"));
    await writeFile(
      join(dir, "Dockerfile"),
      [
        "FROM python:3.13-slim",
        "WORKDIR /app",
        `RUN --mount=type=secret,id=EXAMPLE_TOKEN,required=true test "$(sha256sum < /run/secrets/EXAMPLE_TOKEN | cut -c1-64)" = ${createHash("sha256").update("tok_integration").digest("hex")}`,
        "COPY app.py .",
        "ARG BUILD_ID",
        "ENV BUILD_ID=$BUILD_ID",
        'CMD ["python", "app.py"]',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "turbo-vibe.yaml"),
      [
        "version: 1",
        "project: buildsecret",
        "domain: buildsecret.example.com",
        "services:",
        "  api:",
        "    kind: backend",
        "    target: cloudflare-container",
        "    build: { dockerfile: Dockerfile, secrets: [EXAMPLE_TOKEN] }",
        "",
      ].join("\n"),
    );
    const output: string[] = [];
    const code = await main(
      [
        "--config",
        join(dir, "turbo-vibe.yaml"),
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "integration",
        "--dry-run",
      ],
      {
        cwd: dir,
        env: { ...process.env, EXAMPLE_TOKEN: "tok_integration" },
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
        run: spawnRunner,
        capture: spawnCapturer,
        fetch: globalThis.fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        sql: postgresSession,
      },
    );
    expect(output.join("")).toContain(
      "api: the container answers /api/health with build integration",
    );
    expect(code).toBe(0);
    const history = execFileSync(
      "docker",
      ["history", "--no-trunc", "buildsecret-api:integration"],
      { encoding: "utf8" },
    );
    expect(history).not.toContain("tok_integration");
  }, 600_000);
});
