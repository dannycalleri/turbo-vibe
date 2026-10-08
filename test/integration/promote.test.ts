import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloudflareContainer } from "../../src/adapters/cloudflare.js";
import { loadConfigFile } from "../../src/config/load.js";
import type { Io } from "../../src/io.js";
import { spawnCapturer, spawnRunner } from "../../src/run.js";
import { postgresSession } from "../../src/sql.js";

const example = new URL(
  "../../examples/go-api/turbo-vibe.yaml",
  import.meta.url,
).pathname;
const digest =
  "registry.cloudflare.com/0123456789abcdef0123456789abcdef/tv-example-api@sha256:1111111111111111111111111111111111111111111111111111111111111111";

describe("a promoted backend", () => {
  it("passes wrangler's dry run by image digest, with no build step", async () => {
    const loaded = await loadConfigFile(example);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.problems));
    const commands: string[][] = [];
    const io: Io = {
      cwd: process.cwd(),
      env: process.env,
      stdout: () => {},
      stderr: () => {},
      run: (command, args, options) => {
        commands.push([command, ...args]);
        return spawnRunner(command, args, options);
      },
      capture: spawnCapturer,
      fetch: globalThis.fetch,
      sleep: async () => {},
      sql: postgresSession,
    };
    const service = loaded.config.services.api;
    if (!service) throw new Error("the example has no api service");

    const workDir = await mkdtemp(join(tmpdir(), "turbo-vibe-promote-"));
    const result = await cloudflareContainer.deploy?.({
      config: loaded.config,
      name: "api",
      service,
      environment: "production",
      hostname: "example.turbovibe.ai",
      buildId: "promoted",
      secretNames: [],
      secrets: {},
      buildEnv: {},
      outputs: {},
      dryRun: true,
      configDir: dirname(example),
      workDir,
      io,
      assetsDirs: {},
      recorded: { image: digest },
    });

    expect(result?.code).toBe(0);
    expect(result?.outputs?.image).toBe(digest);
    const wrangler = JSON.parse(
      await readFile(
        join(workDir, "tv-example-api-production", "wrangler.json"),
        "utf8",
      ),
    );
    expect(wrangler.containers[0].image).toBe(digest);
    expect(wrangler.containers[0]).not.toHaveProperty("image_build_context");
    expect(commands.map(([command]) => command)).not.toContain("docker");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("--dry-run");
  });
});
