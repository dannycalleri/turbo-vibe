import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Io } from "../src/io.js";
import { main } from "../src/main.js";
import type { Runner } from "../src/run.js";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => childProcess);

async function run(
  argv: string[],
  files: Record<string, string> = {},
  env: Record<string, string> = {},
  runner: Runner = vi.fn(async () => 0),
  fetch: typeof globalThis.fetch = vi.fn(async () => new Response("unused")),
  overrides: Partial<Io> = {},
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
    fetch,
    sleep: async () => {},
    capture: vi.fn(async () => ({ code: 0, stdout: "{}" })),
    sql: () => ({ execute: async () => {}, end: async () => {} }),
    ...overrides,
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

const project = `version: 1
project: acme
domain: acme.example.com
services:
  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile, test: "go test ./..." }
  web:
    kind: frontend
    target: cloudflare-static
    serve_with: api
    build: { command: "pnpm build", output: dist, test: "pnpm test" }
`;

describe("turbo-vibe deploy", () => {
  const cloudflare = {
    CLOUDFLARE_API_TOKEN: "s3cr3t-token",
    CLOUDFLARE_ACCOUNT_ID: "acc123",
    CLOUDFLARE_ZONE_ID: "zone456",
  };

  it("builds the frontend with the build ID, then ships both in the backend's Worker", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code, cwd } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      cloudflare,
      runner,
    );
    expect(code).toBe(0);
    const workerDir = join(
      cwd,
      ".turbo-vibe",
      "wrangler",
      "staging",
      "acme-api-staging",
    );
    expect(runner.mock.calls).toEqual([
      [
        "sh",
        ["-c", "pnpm build"],
        { cwd, env: { ...cloudflare, BUILD_ID: "abc123" } },
      ],
      [
        process.execPath,
        [
          expect.stringMatching(/wrangler\.js$/),
          "deploy",
          "--config",
          join(workerDir, "wrangler.json"),
        ],
        { cwd: workerDir, env: cloudflare },
      ],
    ]);
    expect(
      await readFile(join(cwd, "dist", "_turbo-vibe", "build-id"), "utf8"),
    ).toBe("abc123");
    const wrangler = JSON.parse(
      await readFile(join(workerDir, "wrangler.json"), "utf8"),
    );
    expect(wrangler.assets.directory).toBe(join(cwd, "dist"));
    expect(wrangler.containers[0].image_vars).toEqual({ BUILD_ID: "abc123" });
  });

  it("ships a frontend without serve_with as its own assets-only Worker", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const frontendOnly = `version: 1
project: acme
domain: acme.example.com
services:
  web:
    kind: frontend
    target: cloudflare-static
    build: { command: "pnpm build", output: dist }
`;
    const { code, cwd } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": frontendOnly },
      cloudflare,
      runner,
    );
    expect(code).toBe(0);
    const workerDir = join(
      cwd,
      ".turbo-vibe",
      "wrangler",
      "staging",
      "acme-web-staging",
    );
    expect(runner.mock.calls[1]).toEqual([
      process.execPath,
      [
        expect.stringMatching(/wrangler\.js$/),
        "deploy",
        "--config",
        join(workerDir, "wrangler.json"),
      ],
      { cwd: workerDir, env: cloudflare },
    ]);
    const wrangler = JSON.parse(
      await readFile(join(workerDir, "wrangler.json"), "utf8"),
    );
    expect(wrangler.name).toBe("acme-web-staging");
    expect(wrangler.assets).toEqual({
      directory: join(cwd, "dist"),
      not_found_handling: "single-page-application",
    });
    expect(wrangler).not.toHaveProperty("containers");
  });

  it("needs no credentials for a dry run", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123", "--dry-run"],
      { "turbo-vibe.yaml": project },
      {},
      runner,
    );
    expect(code).toBe(0);
    expect(runner.mock.calls[1]?.[1]).toContain("--dry-run");
  });

  it("names missing credentials and runs nothing", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const { code, stderr } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      { CLOUDFLARE_API_TOKEN: "t" },
      runner,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "missing environment variables: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID\n",
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("stops before shipping when the frontend build fails", async () => {
    const runner = vi.fn<Runner>(async () => 2);
    const { code, stderr } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      cloudflare,
      runner,
    );
    expect(code).toBe(2);
    expect(stderr).toContain("deploy web failed with exit code 2");
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe("turbo-vibe smoke", () => {
  function serving(
    apiBuild: string,
    pageBuild: string,
  ): typeof globalThis.fetch {
    return vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/api/health")
        ? Response.json({ build_id: apiBuild })
        : new Response(pageBuild),
    );
  }

  it("passes when the API and the page report the build", async () => {
    const fetch = serving("abc123", "abc123");
    const { code, stdout } = await run(
      ["smoke", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      fetch,
    );
    expect(code).toBe(0);
    expect(stdout).toBe(
      "ok api: https://staging.acme.example.com/api/health reports build abc123\n" +
        "ok web: https://staging.acme.example.com/_turbo-vibe/build-id reports build abc123\n",
    );
  });

  it("fails and names both build IDs when an old build still answers", async () => {
    const { code, stderr } = await run(
      ["smoke", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      serving("old999", "abc123"),
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "FAIL api: https://staging.acme.example.com/api/health reports build old999, expected abc123\n",
    );
  });
});

describe("a project with a database", () => {
  const withDb = `${project}  db:
    kind: database
    target: supabase
    organization: acme-org
    region: eu-central-1
`;

  it("deploys and smoke-checks only the services that ship builds", async () => {
    const runner = vi.fn<Runner>(async () => 0);
    const deployed = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": withDb },
      {
        CLOUDFLARE_API_TOKEN: "t",
        CLOUDFLARE_ACCOUNT_ID: "a",
        CLOUDFLARE_ZONE_ID: "z",
      },
      runner,
    );
    expect(deployed.code).toBe(0);
    expect(deployed.stdout).not.toContain("deploy db");
    expect(deployed.stderr).not.toContain("SUPABASE_ACCESS_TOKEN");

    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/api/health")
        ? Response.json({ build_id: "abc123" })
        : new Response("abc123"),
    );
    const smoked = await run(
      ["smoke", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": withDb },
      {},
      undefined,
      fetch,
    );
    expect(smoked.code).toBe(0);
    expect(smoked.stdout).not.toContain("db:");
  });
});

describe("turbo-vibe smoke with a malformed health body", () => {
  it("reports no build rather than an unreachable service", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/api/health")
        ? new Response("OK", { headers: { "content-type": "text/plain" } })
        : new Response("abc123"),
    );
    const { code, stderr } = await run(
      ["smoke", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      fetch,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "FAIL api: https://staging.acme.example.com/api/health reports build (none), expected abc123\n",
    );
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
      ["init", "-input=false"],
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
        /^ALTER ROLE turbo_vibe_runtime WITH LOGIN PASSWORD 'SCRAM-SHA-256\$4096:/,
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
