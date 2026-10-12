import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "../src/apply.js";
import { parseConfig } from "../src/config/load.js";
import type { Runner } from "../src/run.js";
import { project, run } from "./harness.js";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => childProcess);

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

  it("prints the version it was released as", async () => {
    const { version } = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    const { code, stdout } = await run(["--version"]);
    expect(code).toBe(0);
    expect(stdout).toBe(`${version}\n`);
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
      ["tofu", ["init", "-input=false", "-reconfigure"], { cwd: dir, env }],
      [
        "tofu",
        ["apply", "-input=false", join(dir, "tfplan")],
        { cwd: dir, env },
      ],
    ]);
    const root = await readFile(join(dir, "main.tf.json"), "utf8");
    expect(JSON.parse(root).terraform.backend.s3.key).toBe(
      "acme/staging/terraform.tfstate",
    );
    expect(root + stdout + stderr).not.toMatch(/s3cr3t/);
  });

  it("plans against deployed state with --env, prints the summary, and removes the plan file", async () => {
    const runner = vi.fn(async () => 0);
    const capture = vi.fn(async (_command: string, args: readonly string[]) => {
      const out = args.find((arg) => arg.startsWith("-out="));
      if (out) await writeFile(out.slice("-out=".length), "plan");
      const show = {
        resource_changes: [
          {
            address:
              'module.cloudflare.cloudflare_worker.this["acme-api-staging"]',
            change: { actions: ["create"] },
          },
        ],
      };
      return {
        code: 0,
        stdout: args[0] === "show" ? JSON.stringify(show) : "",
      };
    });
    const { code, stdout, cwd } = await run(
      ["plan", "--env", "staging"],
      files,
      env,
      runner,
      undefined,
      { capture },
    );
    const dir = join(cwd, ".turbo-vibe", "tofu", "staging");
    expect(code).toBe(0);
    expect(runner.mock.calls).toEqual([
      ["tofu", ["init", "-input=false", "-reconfigure"], { cwd: dir, env }],
    ]);
    expect(capture.mock.calls.map(([, args]) => args)).toEqual([
      ["plan", "-input=false", "-json", `-out=${join(dir, "tfplan")}`],
      ["show", "-json", join(dir, "tfplan")],
    ]);
    expect(stdout).toBe(
      'staging: 1 to create, 0 to change, 0 to replace, 0 to delete\n\napi\n  + module.cloudflare.cloudflare_worker.this["acme-api-staging"]\n',
    );
    await expect(stat(join(dir, "tfplan"))).rejects.toThrow();
  });

  const planning = (...changes: [string, string[]][]) =>
    vi.fn(async (_command: string, args: readonly string[]) => ({
      code: 0,
      stdout:
        args[0] === "show"
          ? JSON.stringify({
              resource_changes: changes.map(([address, actions]) => ({
                address,
                change: { actions },
              })),
            })
          : "",
    }));
  const worker = 'module.cloudflare.cloudflare_worker.this["acme-old-staging"]';

  it("refuses a plan that deletes or replaces, naming each resource, and applies nothing", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code, stdout, stderr } = await run(
      ["apply", "--env", "staging"],
      files,
      env,
      runner,
      undefined,
      {
        capture: planning(
          [worker, ["delete"]],
          ["module.supabase_db.supabase_project.this[0]", ["delete", "create"]],
          [
            'module.cloudflare.cloudflare_worker.this["acme-api-staging"]',
            ["create"],
          ],
        ),
      },
    );
    expect(code).toBe(1);
    expect(stdout).toContain("Deletions and replacements:");
    expect(stderr).toBe(
      `refusing to apply staging: it would delete or replace 2 resource(s):\n  delete ${worker}\n  replace module.supabase_db.supabase_project.this[0]\nif that is intended, run apply again with --allow-deletions (the workflows' allow-deletions input)\n`,
    );
    expect(runner.mock.calls.map(([, args]) => args[0])).toEqual(["init"]);
  });

  it("applies the plan it showed when deletions are allowed", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code, cwd } = await run(
      ["apply", "--env", "staging", "--allow-deletions"],
      files,
      env,
      runner,
      undefined,
      { capture: planning([worker, ["delete"]]) },
    );
    expect(code).toBe(0);
    expect(runner.mock.calls.at(-1)?.[1]).toEqual([
      "apply",
      "-input=false",
      join(cwd, ".turbo-vibe", "tofu", "staging", "tfplan"),
    ]);
  });

  it("keeps the plan file until tofu apply has finished with it", async () => {
    const capture = vi.fn(async (_command: string, args: readonly string[]) => {
      const out = args.find((arg) => arg.startsWith("-out="));
      if (out) await writeFile(out.slice("-out=".length), "plan");
      return { code: 0, stdout: args[0] === "show" ? "{}" : "" };
    });
    const runner = vi.fn<Runner>(async (_command, args) => {
      if (args[0] !== "apply") return 0;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return (await readFile(args[2] ?? "", "utf8")) === "plan" ? 0 : 1;
    });
    const { code } = await run(
      ["apply", "--env", "staging"],
      files,
      env,
      runner,
      undefined,
      { capture },
    );
    expect(code).toBe(0);
  });

  it("never refuses a preview's deletions", async () => {
    const result = parseConfig(files["turbo-vibe.yaml"]);
    if (!result.ok) throw new Error("invalid fixture");
    const cwd = await mkdtemp(join(tmpdir(), "turbo-vibe-"));
    const runner = vi.fn<Runner>(async () => 0);
    const code = await apply(result.config, "preview-login", {
      cwd,
      env,
      run: runner,
      capture: planning([worker, ["delete"]]),
      fetch: vi.fn(),
      sleep: async () => {},
      sql: () => ({ execute: async () => {}, end: async () => {} }),
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(runner.mock.calls.at(-1)?.[1]?.[0]).toBe("apply");
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

describe("turbo-vibe test", () => {
  it("runs each service's test command in the config's directory", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code, cwd } = await run(
      ["test"],
      { "turbo-vibe.yaml": project },
      {},
      runner,
    );
    expect(code).toBe(0);
    expect(runner.mock.calls).toEqual([
      ["sh", ["-c", "go test ./..."], { cwd, env: {} }],
      ["sh", ["-c", "pnpm test"], { cwd, env: {} }],
    ]);
  });

  it("stops at the first failing test command", async () => {
    const runner = vi.fn<Runner>(async () => 1);
    const { code, stderr } = await run(
      ["test"],
      { "turbo-vibe.yaml": project },
      {},
      runner,
    );
    expect(code).toBe(1);
    expect(stderr).toBe("test api failed with exit code 1\n");
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe("turbo-vibe migrate", () => {
  const withDb = `version: 1
project: acme
domain: acme.example.com
services:
  db:
    kind: database
    target: supabase
    organization: acme-org
    region: eu-central-1
    workdir: backend
`;
  const env = {
    TURBO_VIBE_STATE_BUCKET: "tv-state",
    AWS_ACCESS_KEY_ID: "key-id",
    AWS_SECRET_ACCESS_KEY: "s3cr3t-key",
    CLOUDFLARE_ACCOUNT_ID: "acc123",
    SUPABASE_ACCESS_TOKEN: "s3cr3t-supabase",
  };
  const connection = {
    project_ref: "abcdefghij",
    pooler_urls: {
      transaction:
        "postgresql://postgres.abcdefghij:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
    },
    postgres_password: "pgpw",
    migrator_password: "migpw",
    runtime_password: "runpw",
    migrator_salt: "bWlncmF0b3Itc2FsdA==",
    runtime_salt: "cnVudGltZS1zYWx0LTE2",
  };
  const outputs = JSON.stringify({
    supabase_db_connection: { value: connection, sensitive: true },
  });
  const status = (value: string) =>
    vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ status: value }),
    );

  function sqlRecorder() {
    const sessions: { url: string; statements: string[]; ended: boolean }[] =
      [];
    const sql = (url: string) => {
      const session = { url, statements: [] as string[], ended: false };
      sessions.push(session);
      return {
        execute: async (statement: string) => {
          session.statements.push(statement);
        },
        end: async () => {
          session.ended = true;
        },
      };
    };
    return { sessions, sql };
  }

  it("does nothing for a project without a database", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code, stdout } = await run(
      ["migrate", "--env", "staging"],
      { "turbo-vibe.yaml": project },
      {},
      runner,
    );
    expect(code).toBe(0);
    expect(stdout).toBe("no database to migrate\n");
    expect(runner).not.toHaveBeenCalled();
  });

  it("creates the roles as postgres, then pushes migrations as the migration role over the session pooler", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const capture = vi.fn(async () => ({ code: 0, stdout: outputs }));
    const fetch = status("ACTIVE_HEALTHY");
    const { sessions, sql } = sqlRecorder();
    const { code, cwd, stdout, stderr } = await run(
      ["migrate", "--env", "staging"],
      { "turbo-vibe.yaml": withDb },
      env,
      runner,
      fetch,
      { capture, sql },
    );
    expect(code).toBe(0);
    const tofuDir = join(cwd, ".turbo-vibe", "tofu", "staging");
    expect(runner.mock.calls[0]).toEqual([
      "tofu",
      ["init", "-input=false", "-reconfigure"],
      { cwd: tofuDir, env },
    ]);
    expect(capture).toHaveBeenCalledWith("tofu", ["output", "-json"], {
      cwd: tofuDir,
      env,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.supabase.com/v1/projects/abcdefghij",
      {
        headers: { authorization: "Bearer s3cr3t-supabase" },
      },
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.url).toBe(
      "postgresql://postgres.abcdefghij:pgpw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require",
    );
    expect(sessions[0]?.statements).toContainEqual(
      expect.stringMatching(
        /^ALTER ROLE turbo_vibe_runtime WITH LOGIN PASSWORD 'SCRAM-SHA-256\$4096:cnVudGltZS1zYWx0LTE2\$/,
      ),
    );
    expect(sessions[0]?.statements.join("\n")).not.toMatch(/migpw|runpw/);
    expect(sessions[0]?.ended).toBe(true);

    expect(runner.mock.calls[1]).toEqual([
      process.execPath,
      [
        expect.stringMatching(/supabase\.js$/),
        "db",
        "push",
        "--include-all",
        "--workdir",
        join(cwd, "backend"),
        "--db-url",
        "postgresql://turbo_vibe_migrator.abcdefghij:migpw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require",
      ],
      { cwd: join(cwd, "backend"), env },
    ]);
    expect(stdout + stderr).not.toMatch(/pgpw|migpw|runpw|s3cr3t/);
  });

  it("reports an unreachable Supabase API in one line and touches nothing", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { sessions, sql } = sqlRecorder();
    const { code, stderr } = await run(
      ["migrate", "--env", "staging"],
      { "turbo-vibe.yaml": withDb },
      env,
      runner,
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
      { capture: async () => ({ code: 0, stdout: outputs }), sql },
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "cannot reach the Supabase API (fetch failed); nothing was migrated, rerun\n",
    );
    expect(sessions).toHaveLength(0);
  });

  it("reports a paused project as paused and touches nothing", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { sessions, sql } = sqlRecorder();
    const { code, stderr } = await run(
      ["migrate", "--env", "staging"],
      { "turbo-vibe.yaml": withDb },
      env,
      runner,
      status("INACTIVE"),
      { capture: async () => ({ code: 0, stdout: outputs }), sql },
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "Supabase project abcdefghij is paused; restore it in the Supabase dashboard, then rerun\n",
    );
    expect(sessions).toHaveLength(0);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("stops with the migration's exit code when a migration fails", async () => {
    const runner = vi.fn<Runner>(async (_command, args) =>
      args.includes("push") ? 1 : 0,
    );
    const { code, stderr } = await run(
      ["migrate", "--env", "staging"],
      { "turbo-vibe.yaml": withDb },
      env,
      runner,
      status("ACTIVE_HEALTHY"),
      {
        capture: async () => ({ code: 0, stdout: outputs }),
        sql: sqlRecorder().sql,
      },
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "migrations for db failed with exit code 1; nothing was deployed\n",
    );
  });

  it("stops with a one-line error when role setup fails", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code, stderr } = await run(
      ["migrate", "--env", "staging"],
      { "turbo-vibe.yaml": withDb },
      env,
      runner,
      status("ACTIVE_HEALTHY"),
      {
        capture: async () => ({ code: 0, stdout: outputs }),
        sql: () => ({
          execute: async () => {
            throw new Error('no privileges were granted for "postgres"');
          },
          end: async () => {},
        }),
      },
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      'role setup failed: no privileges were granted for "postgres"\n' +
        "migrations for db failed with exit code 1; nothing was deployed\n",
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("reports a project without a pooler instead of crashing", async () => {
    const noPooler = JSON.stringify({
      supabase_db_connection: {
        value: { ...connection, pooler_urls: {} },
        sensitive: true,
      },
    });
    const { code, stderr } = await run(
      ["migrate", "--env", "staging"],
      { "turbo-vibe.yaml": withDb },
      env,
      vi.fn<Runner>(async () => 0),
      status("ACTIVE_HEALTHY"),
      { capture: async () => ({ code: 0, stdout: noPooler }) },
    );
    expect(code).toBe(1);
    expect(stderr).toBe("Supabase project abcdefghij reports no pooler\n");
  });

  it("asks for apply when the environment has no outputs yet", async () => {
    const { code, stderr } = await run(
      ["migrate", "--env", "staging"],
      { "turbo-vibe.yaml": withDb },
      env,
      vi.fn<Runner>(async () => 0),
      status("ACTIVE_HEALTHY"),
      { capture: async () => ({ code: 0, stdout: "{}" }) },
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "no connection for database db in staging; run apply first\n",
    );
  });

  it("names missing credentials before running anything", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code, stderr } = await run(
      ["migrate", "--env", "staging"],
      { "turbo-vibe.yaml": withDb },
      { ...env, SUPABASE_ACCESS_TOKEN: "" },
      runner,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "missing environment variables: SUPABASE_ACCESS_TOKEN\n",
    );
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("turbo-vibe apply with identity", () => {
  const withAuth = `${project}  auth:
    kind: identity
    target: workos
`;
  const env = {
    TURBO_VIBE_STATE_BUCKET: "tv-state",
    AWS_ACCESS_KEY_ID: "key-id",
    AWS_SECRET_ACCESS_KEY: "s3cr3t-key",
    CLOUDFLARE_ACCOUNT_ID: "acc123",
    CLOUDFLARE_ZONE_ID: "zone456",
    CLOUDFLARE_API_TOKEN: "s3cr3t-token",
    WORKOS_API_KEY: "sk_test_s3cr3t",
    WORKOS_CLIENT_ID: "client_123",
  };
  const callback = "https://staging.acme.example.com/api/auth/callback";
  const workos = (uris: string[]) =>
    vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        object: "list",
        data: uris.map((uri) => ({ uri })),
        list_metadata: { after: null },
      }),
    );

  async function appliedRoot(cwd: string) {
    return JSON.parse(
      await readFile(
        join(cwd, ".turbo-vibe", "tofu", "staging", "main.tf.json"),
        "utf8",
      ),
    );
  }

  it("creates the staging callback when WorkOS does not have it", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code, cwd } = await run(
      ["apply", "--env", "staging"],
      { "turbo-vibe.yaml": withAuth },
      env,
      runner,
      workos([]),
      {
        capture: async () => ({ code: 0, stdout: "{}" }),
      },
    );
    expect(code).toBe(0);
    expect(runner.mock.calls.map(([, args]) => args[0])).toEqual([
      "init",
      "apply",
    ]);
    expect((await appliedRoot(cwd)).module.workos_auth.redirect_uris).toEqual([
      callback,
    ]);
  });

  it("leaves a callback someone registered by hand out of OpenTofu and says so", async () => {
    const { code, cwd, stdout } = await run(
      ["apply", "--env", "staging"],
      { "turbo-vibe.yaml": withAuth },
      env,
      vi.fn<Runner>(async () => 0),
      workos(["https://localhost:3000/callback", callback]),
      { capture: async () => ({ code: 0, stdout: "{}" }) },
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      `redirect URI ${callback} is already registered in WorkOS; leaving it as it is`,
    );
    expect((await appliedRoot(cwd)).module.workos_auth.redirect_uris).toEqual(
      [],
    );
  });

  it("keeps managing the callback it created on an earlier apply", async () => {
    const { cwd } = await run(
      ["apply", "--env", "staging"],
      { "turbo-vibe.yaml": withAuth },
      env,
      vi.fn<Runner>(async () => 0),
      workos([callback]),
      {
        capture: async () => ({
          code: 0,
          stdout: JSON.stringify({
            workos_auth_redirect_uris: { value: [callback] },
          }),
        }),
      },
    );
    expect((await appliedRoot(cwd)).module.workos_auth.redirect_uris).toEqual([
      callback,
    ]);
  });

  it("stops before applying when WorkOS rejects the key", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code, stderr } = await run(
      ["apply", "--env", "staging"],
      { "turbo-vibe.yaml": withAuth },
      env,
      runner,
      vi.fn<typeof globalThis.fetch>(
        async () => new Response("no", { status: 401 }),
      ),
      { capture: async () => ({ code: 0, stdout: "{}" }) },
    );
    expect(code).toBe(1);
    expect(stderr).toBe("WorkOS answered HTTP 401 listing redirect URIs\n");
    expect(runner.mock.calls.map(([, args]) => args[0])).toEqual(["init"]);
    expect(stderr).not.toContain("s3cr3t");
  });
});
