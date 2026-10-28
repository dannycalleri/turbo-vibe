import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply, destroy } from "../src/apply.js";
import { parseConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";
import { smoke } from "../src/deploy.js";
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

  it("prints a backend's port from its Dockerfile", async () => {
    const { code, stdout } = await run(["plan"], {
      "turbo-vibe.yaml":
        "version: 1\nproject: acme\ndomain: acme.example.com\nservices:\n  api:\n    kind: backend\n    target: cloudflare-container\n    build: { dockerfile: Dockerfile }\n",
      Dockerfile: "FROM node\nEXPOSE 3000\n",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("    port: 3000 (EXPOSE in Dockerfile)\n");
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

  it("names a declared secret with no value before changing anything, since the deploy after it would need it", async () => {
    const runner = vi.fn(async () => 0);
    const { code, stderr } = await run(
      ["apply", "--env", "production"],
      {
        "turbo-vibe.yaml": files["turbo-vibe.yaml"].replace(
          "    target: cloudflare-container\n",
          "    target: cloudflare-container\n    secrets: [STRIPE_SECRET_KEY]\n",
        ),
      },
      env,
      runner,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "production has no value for STRIPE_SECRET_KEY, declared in turbo-vibe.yaml; store it in the production GitHub environment with `setup --env production`\n",
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
      sql: () => ({
        execute: async () => {},
        query: async () => [],
        end: async () => {},
      }),
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

describe("turbo-vibe apply on a database branch", () => {
  const branched = `version: 1
project: acme
domain: acme.example.com
services:
  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile }
  db:
    kind: database
    target: supabase
    organization: acme-org
    region: eu-central-1
    plan: paid
    staging: branch
`;
  const env = {
    TURBO_VIBE_STATE_BUCKET: "tv-state",
    AWS_ACCESS_KEY_ID: "key-id",
    AWS_SECRET_ACCESS_KEY: "s3cr3t-key",
    CLOUDFLARE_ACCOUNT_ID: "acc123",
    CLOUDFLARE_ZONE_ID: "zone456",
    CLOUDFLARE_API_TOKEN: "s3cr3t-token",
    SUPABASE_ACCESS_TOKEN: "sbp_t0ken",
  };
  const projects = (list: object[]) =>
    vi.fn<typeof globalThis.fetch>(async () => Response.json(list));

  it("stops before running tofu when the parent project does not exist", async () => {
    const runner = vi.fn(async () => 0);
    const { code, stderr } = await run(
      ["apply", "--env", "staging"],
      { "turbo-vibe.yaml": branched },
      env,
      runner,
      projects([]),
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "the Supabase project acme-db-production does not exist yet; apply production first\n",
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("gives the branch only the parent's ref, found by name in the database's organization", async () => {
    const fetch = projects([
      {
        id: "otherorgref",
        name: "acme-db-production",
        organization_id: "test-org",
      },
      {
        id: "prodref123",
        name: "acme-db-production",
        organization_id: "acme-org",
      },
    ]);
    const { cwd } = await run(
      ["apply", "--env", "staging"],
      { "turbo-vibe.yaml": branched },
      env,
      vi.fn(async () => 0),
      fetch,
    );
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.supabase.com/v1/projects",
    );
    const root = await readFile(
      join(cwd, ".turbo-vibe", "tofu", "staging", "main.tf.json"),
      "utf8",
    );
    expect(JSON.parse(root).module.supabase_db.parent_project_ref).toBe(
      "prodref123",
    );
    expect(root).not.toContain("terraform_remote_state");
  });

  it("refuses two projects with the parent's name in the same organization", async () => {
    const runner = vi.fn(async () => 0);
    const { code, stderr } = await run(
      ["apply", "--env", "staging"],
      { "turbo-vibe.yaml": branched },
      env,
      runner,
      projects([
        { id: "a1", name: "acme-db-production", organization_id: "acme-org" },
        { id: "b2", name: "acme-db-production", organization_slug: "acme-org" },
      ]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "more than one Supabase project is named acme-db-production (a1, b2)",
    );
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

  function sqlRecorder(applied: string[] = []) {
    const sessions: { url: string; statements: string[]; ended: boolean }[] =
      [];
    const sql = (url: string) => {
      const session = { url, statements: [] as string[], ended: false };
      sessions.push(session);
      return {
        execute: async (statement: string) => {
          session.statements.push(statement);
        },
        query: async (statement: string) => {
          session.statements.push(statement);
          return statement.includes("to_regclass")
            ? [{ present: applied.length > 0 }]
            : applied.map((version) => ({ version }));
        },
        end: async () => {
          session.ended = true;
        },
      };
    };
    return { sessions, sql };
  }

  it("refuses a rollback across a migration: the database has a version the commit lacks", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { sql } = sqlRecorder(["20261008000000", "20261010000000"]);
    const { code, stderr } = await run(
      ["migrate", "--env", "staging"],
      {
        "turbo-vibe.yaml": withDb,
        "backend/supabase/migrations/20261008000000_greeting.sql":
          "select 1;\n",
      },
      env,
      runner,
      status("ACTIVE_HEALTHY"),
      { capture: async () => ({ code: 0, stdout: outputs }), sql },
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "the database has migration 20261010000000, which this commit lacks: a rollback cannot cross a migration, so promote a newer build that fixes forward. Nothing was migrated\n" +
        "migrations for db failed with exit code 1; nothing was deployed\n",
    );
    expect(runner.mock.calls.some(([, args]) => args.includes("push"))).toBe(
      false,
    );
  });

  describe("--check", () => {
    const check = (
      applied: string[],
      outputsJson = outputs,
      files: Record<string, string> = {},
    ) => {
      const runner = vi.fn<Runner>(async () => 0);
      const recorder = sqlRecorder(applied);
      return run(
        ["migrate", "--env", "production", "--check"],
        { "turbo-vibe.yaml": withDb, ...files },
        env,
        runner,
        status("ACTIVE_HEALTHY"),
        {
          capture: async () => ({ code: 0, stdout: outputsJson }),
          sql: recorder.sql,
        },
      ).then((result) => ({ ...result, runner, ...recorder }));
    };

    it("refuses a commit that lacks a migration the database has, and changes nothing", async () => {
      const { code, stderr, runner, sessions } = await check([
        "20261010000000",
      ]);
      expect(code).toBe(1);
      expect(stderr).toBe(
        "the database has migration 20261010000000, which this commit lacks: a rollback cannot cross a migration, so promote a newer build that fixes forward. production is unchanged\n",
      );
      expect(sessions.map((session) => session.url)).toEqual([
        expect.stringMatching(/^postgresql:\/\/turbo_vibe_migrator\./),
      ]);
      expect(sessions[0]?.statements.join("\n")).not.toMatch(/ROLE/);
      expect(runner.mock.calls.some(([, args]) => args.includes("push"))).toBe(
        false,
      );
    });

    it("passes a commit that has every applied migration", async () => {
      const { code, stdout } = await check(["20261008000000"], outputs, {
        "backend/supabase/migrations/20261008000000_greeting.sql":
          "select 1;\n",
      });
      expect(code).toBe(0);
      expect(stdout).toContain(
        "database db: this commit has every migration production has applied\n",
      );
    });

    it("warns and passes when it cannot read the migrations, since migrate checks again after apply", async () => {
      const runner = vi.fn<Runner>(async () => 0);
      const { code, stdout } = await run(
        ["migrate", "--env", "production", "--check"],
        { "turbo-vibe.yaml": withDb },
        env,
        runner,
        status("ACTIVE_HEALTHY"),
        {
          capture: async () => ({ code: 0, stdout: outputs }),
          sql: () => ({
            execute: async () => {},
            query: async () => {
              throw new Error(
                'password authentication failed for user "turbo_vibe_migrator"',
              );
            },
            end: async () => {},
          }),
        },
      );
      expect(code).toBe(0);
      expect(stdout).toContain(
        'warn  database db: cannot read the applied migrations (password authentication failed for user "turbo_vibe_migrator"); migrate checks again after apply\n',
      );
      expect(runner.mock.calls.some(([, args]) => args.includes("push"))).toBe(
        false,
      );
    });

    it("passes a production whose database does not exist yet", async () => {
      const { code, stdout, sessions } = await check([], "{}");
      expect(code).toBe(0);
      expect(stdout).toContain(
        "database db does not exist in production yet; no migration to check\n",
      );
      expect(sessions).toEqual([]);
    });
  });

  it("warns and still pushes when it cannot read the applied migrations, since db push compares them itself", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code, stdout } = await run(
      ["migrate", "--env", "staging"],
      { "turbo-vibe.yaml": withDb },
      env,
      runner,
      status("ACTIVE_HEALTHY"),
      {
        capture: async () => ({ code: 0, stdout: outputs }),
        sql: () => ({
          execute: async () => {},
          query: async () => {
            throw new Error("permission denied for schema supabase_migrations");
          },
          end: async () => {},
        }),
      },
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "warn  cannot read the applied migrations (permission denied for schema supabase_migrations); supabase db push compares them itself\n",
    );
    expect(runner.mock.calls.some(([, args]) => args.includes("push"))).toBe(
      true,
    );
  });

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

    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.url).toBe(
      "postgresql://turbo_vibe_migrator.abcdefghij:migpw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require",
    );
    expect(sessions[1]?.ended).toBe(true);
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
          query: async () => [],
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

describe("turbo-vibe apply on a private staging", () => {
  const privateProject = project.replace(
    "services:",
    "environments:\n  staging:\n    access: { emails: [ada@example.com] }\nservices:",
  );
  const env = {
    TURBO_VIBE_STATE_BUCKET: "tv-state",
    AWS_ACCESS_KEY_ID: "key-id",
    AWS_SECRET_ACCESS_KEY: "s3cr3t-key",
    CLOUDFLARE_ACCOUNT_ID: "acc123",
    CLOUDFLARE_ZONE_ID: "zone456",
    CLOUDFLARE_API_TOKEN: "s3cr3t-token",
  };
  const reachable = (...paths: string[]) =>
    vi.fn<typeof globalThis.fetch>(async (url) =>
      paths.some((path) => String(url).endsWith(`${path}/access/apps`))
        ? Response.json({ success: true, result: [] })
        : Response.json({ success: false }, { status: 403 }),
    );
  const applyWith = (
    outputs: Record<string, unknown>,
    fetch = reachable("/zones/zone456"),
  ) =>
    run(
      ["apply", "--env", "staging"],
      { "turbo-vibe.yaml": privateProject },
      env,
      vi.fn<Runner>(async () => 0),
      fetch,
      {
        capture: async (_command, args) => ({
          code: 0,
          stdout:
            args[0] === "output"
              ? JSON.stringify(
                  Object.fromEntries(
                    Object.entries(outputs).map(([name, value]) => [
                      name,
                      { value },
                    ]),
                  ),
                )
              : "{}",
        }),
      },
    );
  const access = async (cwd: string) =>
    JSON.parse(
      await readFile(
        join(cwd, ".turbo-vibe", "tofu", "staging", "main.tf.json"),
        "utf8",
      ),
    ).module.cloudflare.access;

  it("puts Access on the zone for an environment that becomes private", async () => {
    const { code, cwd } = await applyWith({});
    expect(code).toBe(0);
    expect(await access(cwd)).not.toHaveProperty("on_account");
  });

  it("keeps Access on the account for an environment whose outputs hold the 1.0 service token", async () => {
    const { code, cwd } = await applyWith({
      access_client_id: "client.access",
      access_client_secret: "client-secret",
    });
    expect(code).toBe(0);
    expect(await access(cwd)).toMatchObject({ on_account: true });
  });

  it("keeps an environment already on the zone there, without asking Cloudflare", async () => {
    const fetch = reachable();
    const { code, cwd } = await applyWith({ access_on_account: false }, fetch);
    expect(code).toBe(0);
    expect(await access(cwd)).not.toHaveProperty("on_account");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("decides again when an earlier apply recorded the account but failed before creating the service token", async () => {
    const { code, cwd } = await applyWith({
      access_on_account: true,
      access_client_id: null,
    });
    expect(code).toBe(0);
    expect(await access(cwd)).not.toHaveProperty("on_account");
  });

  it("asks Cloudflare nothing about Access for a private project whose hostnames Vercel serves", async () => {
    const fetch = reachable("/zones/zone456");
    const { code } = await run(
      ["apply", "--env", "staging"],
      {
        "turbo-vibe.yaml":
          "version: 1\nproject: acme\ndomain: acme.example.com\nenvironments:\n  staging:\n    access: { emails: [ada@example.com] }\nservices:\n  web:\n    kind: frontend\n    target: vercel-static\n    build: { command: x, output: dist }\n",
      },
      { ...env, VERCEL_API_TOKEN: "vercel-s3cr3t", VERCEL_TEAM_ID: "team_123" },
      vi.fn<Runner>(async () => 0),
      fetch,
    );
    expect(code).toBe(0);
    expect(
      fetch.mock.calls.filter(([url]) => String(url).includes("/access/apps")),
    ).toEqual([]);
  });

  it("puts a new environment on the account when its 1.0 token reaches Access there only, as a new preview of a 1.0 staging", async () => {
    const { code, cwd } = await applyWith({}, reachable("/accounts/acc123"));
    expect(code).toBe(0);
    expect(await access(cwd)).toMatchObject({ on_account: true });
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

describe("smoke on a private environment", () => {
  const buildId = "abc1230000000000000000000000000000000000";
  const parsed = (yaml: string): Config => {
    const result = parseConfig(yaml);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.config;
  };
  const privately = (yaml: string) =>
    parsed(
      yaml.replace(
        "services:",
        "environments:\n  production:\n    access: { emails: [ada@example.com] }\nservices:",
      ),
    );
  const site = privately(
    "version: 1\nproject: acme\ndomain: acme.example.com\nservices:\n  web:\n    kind: frontend\n    target: vercel-static\n    build: { command: x, output: dist }\n",
  );
  const bypass = {
    "acme-web-production": "production-bypass-s3cr3t",
    "acme-web-staging": "staging-bypass-s3cr3t",
  };

  async function smokeWith(
    config: Config,
    outputs: Record<string, unknown>,
    env: Record<string, string> = {},
    health = () => Response.json({ build_id: buildId }),
  ) {
    const cwd = await mkdtemp(join(tmpdir(), "turbo-vibe-"));
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/_turbo-vibe/health")
        ? health()
        : new Response(buildId),
    );
    let stdout = "";
    let stderr = "";
    const code = await smoke(config, "production", buildId, {
      cwd,
      env,
      run: async () => 0,
      capture: async () => ({
        code: 0,
        stdout: JSON.stringify(
          Object.fromEntries(
            Object.entries(outputs).map(([name, value]) => [name, { value }]),
          ),
        ),
      }),
      fetch,
      sleep: async () => {},
      sql: () => {
        throw new Error("no database");
      },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    const headers = fetch.mock.calls.map(
      ([, init]) => new Headers(init?.headers),
    );
    return { code, stdout, stderr, fetch, headers };
  }

  it("sends the person to the Worker's logs when the private health answer holds no reason", async () => {
    const { code, stderr } = await smokeWith(
      privately(project),
      { access_on_account: false },
      {},
      () => Response.json({ build_id: buildId }, { status: 502 }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "https://acme.example.com/_turbo-vibe/health answered HTTP 502: a private environment keeps the reason out of this public answer; read it in the Worker's logs (`wrangler tail acme-api-production`, or Workers & Pages → acme-api-production → Logs)",
    );
  });

  it("passes Vercel's protection with the secret of the environment's own project", async () => {
    const { code, headers } = await smokeWith(site, {
      vercel_protection_bypass: bypass,
    });
    expect(code).toBe(0);
    expect(headers.map((h) => h.get("x-vercel-protection-bypass"))).toEqual([
      "production-bypass-s3cr3t",
    ]);
  });

  it("fails before any request, naming apply, when the outputs hold no secret for the project", async () => {
    const { code, stderr, fetch } = await smokeWith(site, {
      vercel_protection_bypass: { "acme-web-staging": "staging-bypass-s3cr3t" },
    });
    expect(code).toBe(1);
    expect(stderr).toBe(
      "FAIL web: no protection bypass for the Vercel project of web in production; run apply first\n",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("masks every bypass secret first in GitHub Actions, and prints none", async () => {
    const { code, stdout, stderr } = await smokeWith(
      site,
      { vercel_protection_bypass: bypass },
      { GITHUB_ACTIONS: "true" },
    );
    expect(code).toBe(0);
    const lines = stdout.split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "::add-mask::production-bypass-s3cr3t",
      "::add-mask::staging-bypass-s3cr3t",
    ]);
    expect(lines.slice(2).join("\n") + stderr).not.toContain("s3cr3t");
  });

  it("masks the Access service token of an environment made private with turbo-vibe 1.0", async () => {
    const { code, stdout, stderr, headers } = await smokeWith(
      privately(project),
      {
        access_client_id: "client.access",
        access_client_secret: "client-s3cr3t",
      },
      { GITHUB_ACTIONS: "true" },
    );
    expect(code).toBe(0);
    expect(headers[0]?.get("cf-access-client-secret")).toBe("client-s3cr3t");
    expect(stdout.split("\n")[0]).toBe("::add-mask::client-s3cr3t");
    expect(stdout.split("\n").slice(1).join("\n") + stderr).not.toContain(
      "s3cr3t",
    );
  });

  it("writes no mask outside GitHub Actions, and prints no secret", async () => {
    const { code, stdout, stderr } = await smokeWith(site, {
      vercel_protection_bypass: bypass,
    });
    expect(code).toBe(0);
    expect(stdout).not.toContain("::add-mask::");
    expect(stdout + stderr).not.toContain("s3cr3t");
  });
});

describe("the bypass secret of a private Vercel project", () => {
  const site = (() => {
    const result = parseConfig(
      "version: 1\nproject: acme\ndomain: acme.example.com\nenvironments:\n  staging:\n    access: { emails: [ada@example.com] }\nservices:\n  web:\n    kind: frontend\n    target: vercel-static\n    build: { command: x, output: dist }\n",
    );
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.config;
  })();
  const credentials = {
    TURBO_VIBE_STATE_BUCKET: "tv-state",
    AWS_ACCESS_KEY_ID: "key-id",
    AWS_SECRET_ACCESS_KEY: "s3cr3t-key",
    CLOUDFLARE_ACCOUNT_ID: "acc123",
    CLOUDFLARE_ZONE_ID: "zone456",
    CLOUDFLARE_API_TOKEN: "s3cr3t-token",
    VERCEL_API_TOKEN: "vercel-s3cr3t",
    VERCEL_TEAM_ID: "team_123",
  };

  // The fake OpenTofu prints each bypass's ID as the real one does, the project's ID then the secret: those in the
  // state (refreshed or destroyed), and those it receives (created).
  async function tofu(
    command: typeof apply | typeof destroy,
    environment: string,
    state: Record<string, string>,
    extra: Record<string, string> = {},
  ) {
    const cwd = await mkdtemp(join(tmpdir(), "turbo-vibe-"));
    const log: string[] = [];
    const passed: Record<string, string>[] = [];
    const runner = vi.fn<Runner>(async (_command, args, options) => {
      if (args[0] === "apply" || args[0] === "destroy") {
        const received = JSON.parse(
          options.env?.TF_VAR_vercel_protection_bypass ?? "{}",
        ) as Record<string, string>;
        passed.push(received);
        for (const secret of new Set([
          ...Object.values(state),
          ...Object.values(received),
        ]))
          log.push(`[id=prj_1/${secret}]`);
      }
      return 0;
    });
    const code = await command(site, environment as "staging", {
      cwd,
      env: { ...credentials, ...extra },
      run: runner,
      capture: async (_command, args) => ({
        code: 0,
        stdout:
          args[0] === "show" && args.length === 2
            ? JSON.stringify({
                values: {
                  root_module: {
                    child_modules: [
                      {
                        address: "module.vercel",
                        resources: Object.entries(state).map(
                          ([project, secret]) => ({
                            type: "vercel_project_protection_bypass",
                            index: project,
                            values: { secret },
                          }),
                        ),
                      },
                    ],
                  },
                },
              })
            : args[0] === "show"
              ? JSON.stringify({ resource_changes: [] })
              : "{}",
      }),
      fetch: vi.fn(),
      sleep: async () => {},
      sql: () => ({
        execute: async () => {},
        query: async () => [],
        end: async () => {},
      }),
      stdout: (text) => log.push(...text.trimEnd().split("\n")),
      stderr: (text) => log.push(...text.trimEnd().split("\n")),
    });
    const firstId = log.findIndex((line) => line.startsWith("[id="));
    const maskedFirst = (secret: string) => {
      const mask = log.indexOf(`::add-mask::${secret}`);
      return mask >= 0 && mask < firstId;
    };
    return { code, log, passed, maskedFirst };
  }

  it("chooses a new 32-character secret, and masks it in GitHub Actions before OpenTofu prints it", async () => {
    const { code, passed, maskedFirst } = await tofu(
      apply,
      "staging",
      {},
      { GITHUB_ACTIONS: "true" },
    );
    expect(code).toBe(0);
    const secret = passed[0]?.["acme-web-staging"] ?? "";
    expect(secret).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(maskedFirst(secret)).toBe(true);
  });

  it("keeps and masks the secret in the state, also one that no output lists yet after an apply that stopped part of the way", async () => {
    const { passed, maskedFirst } = await tofu(
      apply,
      "staging",
      { "acme-web-staging": "kept-bypass-s3cr3t" },
      { GITHUB_ACTIONS: "true" },
    );
    expect(passed).toEqual([{ "acme-web-staging": "kept-bypass-s3cr3t" }]);
    expect(maskedFirst("kept-bypass-s3cr3t")).toBe(true);
  });

  it("masks the secret of a preview before OpenTofu destroys it", async () => {
    const { code, passed, maskedFirst } = await tofu(
      destroy,
      "preview-login",
      { "acme-web-preview-login": "preview-bypass-s3cr3t" },
      { GITHUB_ACTIONS: "true" },
    );
    expect(code).toBe(0);
    expect(passed).toEqual([
      { "acme-web-preview-login": "preview-bypass-s3cr3t" },
    ]);
    expect(maskedFirst("preview-bypass-s3cr3t")).toBe(true);
  });

  it("masks the secret of a bypass that apply deletes, when access goes away", async () => {
    const { passed, maskedFirst } = await tofu(
      apply,
      "production",
      { "acme-web-production": "old-bypass-s3cr3t" },
      { GITHUB_ACTIONS: "true" },
    );
    expect(passed).toEqual([{}]);
    expect(maskedFirst("old-bypass-s3cr3t")).toBe(true);
  });

  it("writes no mask outside GitHub Actions", async () => {
    const { log, passed } = await tofu(apply, "staging", {});
    expect(passed[0]?.["acme-web-staging"]).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(log.some((line) => line.startsWith("::add-mask::"))).toBe(false);
  });
});
