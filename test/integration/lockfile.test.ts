import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { npmLockfile } from "../../src/checks/local.js";
import { parseConfig } from "../../src/config/load.js";
import type { Io } from "../../src/io.js";
import { spawnCapturer, spawnRunner } from "../../src/run.js";
import { postgresSession } from "../../src/sql.js";

const parsed = parseConfig(
  'version: 1\nproject: site\ndomain: site.example.com\nservices:\n  web:\n    kind: frontend\n    target: cloudflare-static\n    build: { command: "npm ci && npm run build", output: dist }\n',
);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
const config = parsed.config;

// A file: dependency keeps npm off the registry, so the test needs no network.
async function site(lockedWithDependency: boolean): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "turbo-vibe-lockfile-"));
  await mkdir(join(folder, "dep"));
  await writeFile(
    join(folder, "dep", "package.json"),
    '{"name":"dep","version":"1.0.0"}',
  );
  const manifest = (dependencies: object) =>
    writeFile(
      join(folder, "package.json"),
      JSON.stringify({ name: "site", version: "1.0.0", dependencies }),
    );
  await manifest(lockedWithDependency ? { dep: "file:./dep" } : {});
  const locked = await spawnCapturer(
    "npm",
    ["install", "--package-lock-only", "--offline", "--no-audit", "--no-fund"],
    { cwd: folder, env: process.env, quiet: true },
  );
  expect(locked.code).toBe(0);
  await manifest({ dep: "file:./dep" });
  return folder;
}

const io = (cwd: string): Io => ({
  cwd,
  env: process.env,
  stdout: () => {},
  stderr: () => {},
  run: spawnRunner,
  capture: spawnCapturer,
  fetch: globalThis.fetch,
  sleep: async () => {},
  sql: postgresSession,
});

describe("npmLockfile with the real npm", () => {
  it("fails on a lockfile that misses a dependency, and installs nothing", async () => {
    const folder = await site(false);
    const before = await readFile(join(folder, "package-lock.json"), "utf8");
    const findings = await npmLockfile({
      config,
      environment: "staging",
      io: io(folder),
      nodeVersion: process.versions.node,
      configDir: folder,
    });
    expect(findings.map(({ severity }) => severity)).toEqual(["fail"]);
    await expect(access(join(folder, "node_modules"))).rejects.toThrow();
    expect(await readFile(join(folder, "package-lock.json"), "utf8")).toBe(
      before,
    );
  });

  it("passes on a lockfile that matches package.json", async () => {
    const folder = await site(true);
    const findings = await npmLockfile({
      config,
      environment: "staging",
      io: io(folder),
      nodeVersion: process.versions.node,
      configDir: folder,
    });
    expect(findings.map(({ severity }) => severity)).toEqual(["ok"]);
    await expect(access(join(folder, "node_modules"))).rejects.toThrow();
  });
});
