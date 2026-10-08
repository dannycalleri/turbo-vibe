import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { spawnCapturer, spawnRunner } from "../../src/run.js";
import { postgresSession } from "../../src/sql.js";

describe("the workflows init writes", () => {
  it("pass actionlint", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "turbo-vibe-init-"));
    const code = await main(
      [
        "init",
        "--name",
        "shop",
        "--domain",
        "shop.example.com",
        "--backend",
        "cloudflare-container",
        "--frontend",
        "vercel-static",
        "--database",
        "supabase",
        "--identity",
        "workos",
      ],
      {
        cwd,
        env: process.env,
        stdout: () => {},
        stderr: () => {},
        run: spawnRunner,
        capture: spawnCapturer,
        fetch: globalThis.fetch,
        sleep: async () => {},
        sql: postgresSession,
      },
    );
    expect(code).toBe(0);
    const files = [
      ".github/workflows/staging.yml",
      ".github/workflows/production.yml",
    ];
    const lint = (() => {
      try {
        execFileSync("actionlint", ["-version"], { stdio: "ignore" });
        return ["actionlint", ["-no-color", ...files]] as const;
      } catch {
        return [
          "docker",
          [
            "run",
            "--rm",
            "-v",
            `${cwd}:/repo`,
            "-w",
            "/repo",
            "rhysd/actionlint:1.7.12",
            "-no-color",
            ...files,
          ],
        ] as const;
      }
    })();
    expect(() =>
      execFileSync(lint[0], [...lint[1]], { cwd, encoding: "utf8" }),
    ).not.toThrow();
  });
});
