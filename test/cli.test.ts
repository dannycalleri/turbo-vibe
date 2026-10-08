import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";
import type { Runner } from "../src/run.js";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => childProcess);

async function run(
  argv: string[],
  files: Record<string, string> = {},
  env: Record<string, string> = {},
  runner: Runner = vi.fn(async () => 0),
) {
  const cwd = await mkdtemp(join(tmpdir(), "turbo-vibe-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(cwd, name), content);
  }
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env,
    run: runner,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, cwd };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("turbo-vibe plan", () => {
  it("prints the plan for a valid config", async () => {
    const { code, stdout } = await run(["plan"], {
      "turbo-vibe.yaml":
        "version: 1\nproject: acme\ndomain: acme.example.com\nservices:\n  api:\n    kind: backend\n    target: cloudflare-container\n    build: { dockerfile: Dockerfile }\n",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("staging (staging.acme.example.com)");
  });

  it("stops with file:line errors and calls nothing external when validation fails", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { code, stdout, stderr, cwd } = await run(["plan"], {
      "turbo-vibe.yaml":
        "version: 1\nproject: acme\ndomain: acme.example.com\nservices: {}\nextra: true\n",
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      `${join(cwd, "turbo-vibe.yaml")}:5: unknown key \`extra\``,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it("reads the file named by --config", async () => {
    const { code, stderr } = await run(["--config", "missing.yaml", "plan"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/missing\.yaml: cannot read/);
  });

  it("exits non-zero on an unknown command", async () => {
    const { code } = await run(["nope"]);
    expect(code).not.toBe(0);
  });
});

describe("turbo-vibe apply", () => {
  const files = {
    "turbo-vibe.yaml":
      "version: 1\nproject: acme\ndomain: acme.example.com\nservices:\n  api:\n    kind: backend\n    target: cloudflare-container\n    build: { dockerfile: Dockerfile }\n",
  };
  const env = {
    TURBO_VIBE_STATE_BUCKET: "tv-state",
    AWS_ACCESS_KEY_ID: "key-id",
    AWS_SECRET_ACCESS_KEY: "s3cr3t-key",
    CLOUDFLARE_ACCOUNT_ID: "acc123",
    CLOUDFLARE_ZONE_ID: "zone456",
    CLOUDFLARE_API_TOKEN: "s3cr3t-token",
  };

  it("names missing environment variables and runs nothing", async () => {
    const runner = vi.fn(async () => 0);
    const { code, stderr } = await run(
      ["apply", "--env", "staging"],
      files,
      { ...env, CLOUDFLARE_API_TOKEN: "", AWS_ACCESS_KEY_ID: "" },
      runner,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "missing environment variables: AWS_ACCESS_KEY_ID, CLOUDFLARE_API_TOKEN\n",
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("writes the environment's root module and runs tofu init then apply in it", async () => {
    const runner = vi.fn(async () => 0);
    const { code, stdout, stderr, cwd } = await run(
      ["apply", "--env", "staging"],
      files,
      env,
      runner,
    );
    const dir = join(cwd, ".turbo-vibe", "tofu", "staging");
    expect(code).toBe(0);
    expect(runner.mock.calls).toEqual([
      ["tofu", ["init", "-input=false"], { cwd: dir, env }],
      ["tofu", ["apply", "-input=false", "-auto-approve"], { cwd: dir, env }],
    ]);
    const root = await readFile(join(dir, "main.tf.json"), "utf8");
    expect(JSON.parse(root).terraform.backend.s3.key).toBe(
      "acme/staging/terraform.tfstate",
    );
    expect(root + stdout + stderr).not.toMatch(/s3cr3t/);
  });

  it("stops when tofu init fails", async () => {
    const runner = vi.fn(async () => 3);
    const { code } = await run(
      ["apply", "--env", "staging"],
      files,
      env,
      runner,
    );
    expect(code).toBe(3);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("requires a known environment", async () => {
    const runner = vi.fn(async () => 0);
    const { code, stderr } = await run(
      ["apply", "--env", "qa"],
      files,
      env,
      runner,
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("staging, production");
    expect(runner).not.toHaveBeenCalled();
  });
});
