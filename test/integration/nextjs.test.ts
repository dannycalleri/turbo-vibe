import { access, mkdtemp, readdir, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { vercelNextjs } from "../../src/adapters/vercel.js";
import { loadConfigFile } from "../../src/config/load.js";
import type { Io } from "../../src/io.js";
import { spawnCapturer, spawnRunner } from "../../src/run.js";
import { placeholder, withPublicValues } from "../../src/secrets.js";
import { postgresSession } from "../../src/sql.js";

const example = new URL(
  "../../examples/nextjs/turbo-vibe.yaml",
  import.meta.url,
).pathname;

describe("the Next.js example", () => {
  it("builds into the Vercel build output format with its server-rendered page", async () => {
    const loaded = await loadConfigFile(example);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.problems));
    const service = loaded.config.services.web;
    if (!service) throw new Error("the example has no web service");
    const io: Io = {
      cwd: process.cwd(),
      env: process.env,
      stdout: () => {},
      stderr: () => {},
      run: spawnRunner,
      capture: spawnCapturer,
      fetch: globalThis.fetch,
      sleep: async () => {},
      sql: postgresSession,
    };

    const workDir = await mkdtemp(join(tmpdir(), "turbo-vibe-next-"));
    const result = await vercelNextjs.deploy?.({
      config: loaded.config,
      name: "web",
      service,
      environment: "staging",
      hostname: "staging-next-example.turbovibe.ai",
      backendHostname: "staging-next-example.turbovibe.ai",
      buildId: "integration",
      secretNames: [],
      secrets: {},
      publicValues: {},
      buildSecrets: {},
      buildEnv: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NEXT_PUBLIC_EXAMPLE_NAME: placeholder("NEXT_PUBLIC_EXAMPLE_NAME"),
      },
      outputs: {},
      dryRun: true,
      configDir: dirname(example),
      workDir,
      io,
      assetsDirs: {},
    });

    expect(result?.code).toBe(0);
    const output = join(dirname(example), ".vercel", "output");
    expect(
      JSON.parse(await readFile(join(output, "config.json"), "utf8")).version,
    ).toBe(3);
    await access(join(output, "functions", "index.func"));
    expect(
      await readFile(join(output, "static", "_turbo-vibe", "build-id"), "utf8"),
    ).toBe("integration");
    const shipped = join(
      workDir,
      "web-vercel",
      ".vercel",
      "output",
      "functions",
    );
    expect(await readlink(join(shipped, "index.rsc.func"))).toBe("index.func");
    const function_ = join(shipped, "index.func");
    const vcConfig = JSON.parse(
      await readFile(join(function_, ".vc-config.json"), "utf8"),
    );
    expect(Object.keys(vcConfig.filePathMap ?? {})).toEqual([]);
    await access(join(function_, "node_modules", "client-only", "index.js"));
    await expect(
      access(join(dirname(example), ".vercel", "project.json")),
    ).rejects.toThrow();

    const copy = join(workDir, "public");
    expect(
      await withPublicValues(
        output,
        copy,
        { NEXT_PUBLIC_EXAMPLE_NAME: "staging-name" },
        io,
      ),
    ).toBe(copy);
    const holding = async (dir: string, text: string): Promise<string[]> => {
      const found: string[] = [];
      for (const entry of await readdir(dir, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        if ((await readFile(path)).includes(text)) found.push(path);
      }
      return found;
    };
    expect(await holding(copy, "__TURBO_VIBE_PUBLIC_")).toEqual([]);
    expect(
      (await holding(join(copy, "static"), "staging-name")).some((path) =>
        path.endsWith(".js"),
      ),
    ).toBe(true);
    expect(
      (await holding(join(copy, "functions"), "staging-name")).length,
    ).toBeGreaterThan(0);
  });
});
