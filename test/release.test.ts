import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BuildRecord } from "../src/builds.js";
import {
  capturing,
  digest,
  fakeR2,
  project,
  run,
  runner,
  stateEnv,
} from "./harness.js";

const cloudflare = {
  CLOUDFLARE_API_TOKEN: "s3cr3t-token",
  CLOUDFLARE_ZONE_ID: "zone456",
};
const env = { ...stateEnv, ...cloudflare };
const record = (overrides: Partial<BuildRecord>): BuildRecord => ({
  buildId: "abc123",
  createdAt: "2026-10-08T10:00:00.000Z",
  smoke: "passed",
  services: {
    api: { image: digest },
    web: { assets: "acme/builds/abc123/web.tar.gz" },
  },
  ...overrides,
});
const seeded = (...records: BuildRecord[]) =>
  Object.fromEntries(
    records.map((r) => [`acme/builds/${r.buildId}.json`, JSON.stringify(r)]),
  );

async function workerConfig(cwd: string, environment: string, worker: string) {
  return JSON.parse(
    await readFile(
      join(
        cwd,
        ".turbo-vibe",
        "wrangler",
        environment,
        worker,
        "wrangler.json",
      ),
      "utf8",
    ),
  );
}

describe("deploy to staging", () => {
  it("builds once, pushes the image, ships it by digest, and records the build", async () => {
    const r2 = fakeR2();
    const calls = runner();
    const { code, cwd } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      env,
      calls,
      r2.fetch(),
      { capture: capturing() },
    );
    expect(code).toBe(0);
    expect(
      calls.mock.calls.map(([command, args]) => [command, args.slice(0, 3)]),
    ).toEqual([
      ["sh", ["-c", "pnpm build"]],
      [
        "tar",
        [
          "-czf",
          join(cwd, ".turbo-vibe", "wrangler", "staging", "web-assets.tar.gz"),
          "-C",
        ],
      ],
      ["docker", ["build", "--platform", "linux/amd64"]],
      [
        process.execPath,
        [expect.stringMatching(/wrangler\.js$/), "containers", "push"],
      ],
      [
        process.execPath,
        [expect.stringMatching(/wrangler\.js$/), "deploy", "--config"],
      ],
    ]);
    expect(calls.mock.calls[0]?.[2].env).toEqual({ BUILD_ID: "abc123" });
    expect(calls.mock.calls[2]?.[1]).toContain("BUILD_ID=abc123");
    const deployArgs =
      calls.mock.calls.find((call) => call[1][1] === "deploy")?.[1] ?? [];
    expect(deployArgs[deployArgs.indexOf("--containers-rollout") + 1]).toBe(
      "immediate",
    );

    const config = await workerConfig(cwd, "staging", "acme-api-staging");
    expect(config.containers[0]).toEqual({
      class_name: "Backend",
      image: digest,
      instance_type: "lite",
      max_instances: 1,
    });
    expect(config.assets.directory).toBe(join(cwd, "dist"));
    expect(
      await readFile(join(cwd, "dist", "_turbo-vibe", "build-id"), "utf8"),
    ).toBe("abc123");

    expect(r2.objects.has("acme/builds/abc123/web.tar.gz")).toBe(true);
    expect(r2.record("acme/builds/abc123.json")).toEqual({
      buildId: "abc123",
      createdAt: expect.any(String),
      smoke: "pending",
      services: {
        web: { assets: "acme/builds/abc123/web.tar.gz" },
        api: { image: digest },
      },
    });
    expect(r2.unsigned).toEqual([]);
  });

  it("ships a frontend without serve_with as its own assets-only Worker", async () => {
    const frontendOnly = `version: 1
project: acme
domain: acme.example.com
services:
  web:
    kind: frontend
    target: cloudflare-static
    build: { command: "pnpm build", output: dist }
`;
    const r2 = fakeR2();
    const { code, cwd } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": frontendOnly },
      env,
      runner(),
      r2.fetch(),
    );
    expect(code).toBe(0);
    const config = await workerConfig(cwd, "staging", "acme-web-staging");
    expect(config.assets).toEqual({
      directory: join(cwd, "dist"),
      not_found_handling: "single-page-application",
    });
    expect(config).not.toHaveProperty("containers");
    expect(r2.record("acme/builds/abc123.json").services).toEqual({
      web: { assets: "acme/builds/abc123/web.tar.gz" },
    });
  });

  it("builds and validates without credentials, uploads, or a record in a dry run", async () => {
    const calls = runner();
    const r2 = fakeR2();
    const { code, cwd } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123", "--dry-run"],
      { "turbo-vibe.yaml": project },
      {},
      calls,
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(calls.mock.calls.map(([command]) => command)).toEqual([
      "sh",
      process.execPath,
    ]);
    expect(calls.mock.calls[1]?.[1]).toContain("--dry-run");
    expect(
      (await workerConfig(cwd, "staging", "acme-api-staging")).containers[0],
    ).toMatchObject({
      image: join(cwd, "Dockerfile"),
      image_vars: { BUILD_ID: "abc123" },
    });
    expect(r2.objects.size).toBe(0);
  });

  it("names every missing credential, the state bucket's included, and runs nothing", async () => {
    const calls = runner();
    const { code, stderr } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      { CLOUDFLARE_API_TOKEN: "t" },
      calls,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "missing environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, TURBO_VIBE_STATE_BUCKET\n",
    );
    expect(calls).not.toHaveBeenCalled();
  });

  it("stops before shipping, and records nothing, when the frontend build fails", async () => {
    const r2 = fakeR2();
    const calls = runner((command) => (command === "sh" ? 2 : undefined));
    const { code, stderr } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      env,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(2);
    expect(stderr).toContain("deploy web failed with exit code 2");
    expect(calls).toHaveBeenCalledTimes(1);
    expect(r2.objects.size).toBe(0);
  });

  it("records the digest of the repository it pushed to, not another one sharing the image", async () => {
    const r2 = fakeR2();
    const { code } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      env,
      runner(),
      r2.fetch(),
      {
        capture: capturing({}, [
          "registry.cloudflare.com/acc123/other-service@sha256:2222222222222222222222222222222222222222222222222222222222222222",
          "registry.cloudflare.com/someone-else/acme-api@sha256:3333333333333333333333333333333333333333333333333333333333333333",
          digest,
        ]),
      },
    );
    expect(code).toBe(0);
    expect(r2.record("acme/builds/abc123.json").services.api).toEqual({
      image: digest,
    });
  });

  it("fails when the pushed image has no registry digest", async () => {
    const r2 = fakeR2();
    const { code, stderr } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      env,
      runner(),
      r2.fetch(),
      { capture: capturing({}, ["acme-api@sha256:local"]) },
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "cannot find the pushed digest of acme-api:abc123 in the Cloudflare registry",
    );
    expect(r2.objects.has("acme/builds/abc123.json")).toBe(false);
  });

  it("refuses production: production only receives promoted builds", async () => {
    const calls = runner();
    const { code, stderr } = await run(
      ["deploy", "--env", "production", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      env,
      calls,
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "production is deployed with `turbo-vibe promote`",
    );
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("smoke", () => {
  const serving =
    (apiBuild: string, pageBody = apiBuild) =>
    (url: string) =>
      url.endsWith("/api/health")
        ? Response.json({ build_id: apiBuild })
        : new Response(pageBody);

  it("records a passing staging build as promotable", async () => {
    const r2 = fakeR2(seeded(record({ smoke: "pending" })));
    const { code, stdout } = await run(
      ["smoke", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      stateEnv,
      undefined,
      r2.fetch(serving("abc123")),
    );
    expect(code).toBe(0);
    expect(stdout).toBe(
      "ok api: https://staging.acme.example.com/api/health reports build abc123\n" +
        "ok web: https://staging.acme.example.com/_turbo-vibe/build-id reports build abc123\n",
    );
    expect(r2.record("acme/builds/abc123.json").smoke).toBe("passed");
  });

  it("records a failing staging build and names both build IDs", async () => {
    const r2 = fakeR2(seeded(record({ smoke: "pending" })));
    const { code, stderr } = await run(
      ["smoke", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      stateEnv,
      undefined,
      r2.fetch(serving("old999", "abc123")),
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "FAIL api: https://staging.acme.example.com/api/health reports build old999, expected abc123; the container may still run the previous image: Cloudflare replaces it by sending SIGTERM and waits up to 15 minutes, so make its main process exit on SIGTERM\n",
    );
    expect(r2.record("acme/builds/abc123.json").smoke).toBe("failed");
  });

  it("reports a malformed health body as no build rather than an unreachable service", async () => {
    const r2 = fakeR2(seeded(record({ smoke: "pending" })));
    const { stderr } = await run(
      ["smoke", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      stateEnv,
      undefined,
      r2.fetch((url) =>
        url.endsWith("/api/health")
          ? new Response("OK")
          : new Response("abc123"),
      ),
    );
    expect(stderr).toContain("reports build (none), expected abc123");
  });

  it("fails a staging build that has no record, since it could never be promoted", async () => {
    const { code, stderr } = await run(
      ["smoke", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      stateEnv,
      undefined,
      fakeR2().fetch(serving("abc123")),
    );
    expect(code).toBe(1);
    expect(stderr).toBe("no build record for abc123; it cannot be promoted\n");
  });

  it("checks production without touching build records", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) =>
      serving("abc123")(String(input)),
    );
    const { code } = await run(
      ["smoke", "--env", "production", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      fetch,
    );
    expect(code).toBe(0);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://acme.example.com/api/health",
      "https://acme.example.com/_turbo-vibe/build-id",
    ]);
  });
});

describe("promote", () => {
  it("stops before changing anything when no staging build has passed", async () => {
    const calls = runner();
    const r2 = fakeR2(
      seeded(
        record({ smoke: "failed" }),
        record({ buildId: "def456", smoke: "pending" }),
      ),
    );
    const { code, stderr } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": project },
      env,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "no staging build has passed its smoke test; production is unchanged\n",
    );
    expect(calls).not.toHaveBeenCalled();
  });

  it("skips a newer failed build for the last passing one, and deploys only its recorded outputs", async () => {
    const calls = runner();
    const r2 = fakeR2({
      ...seeded(
        record({}),
        record({
          buildId: "new999",
          createdAt: "2026-10-08T12:00:00.000Z",
          smoke: "failed",
        }),
      ),
      "acme/builds/abc123/web.tar.gz": "archive",
    });
    const { code, cwd, stdout } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": project },
      env,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("promote build abc123 to production");
    const assets = join(
      cwd,
      ".turbo-vibe",
      "wrangler",
      "production",
      "web-assets",
    );
    expect(
      calls.mock.calls.map(([command, args]) => [command, args[1]]),
    ).toEqual([
      ["tar", `${assets}.tar.gz`],
      [process.execPath, "deploy"],
    ]);
    const config = await workerConfig(cwd, "production", "acme-api-production");
    expect(config.containers[0]).toMatchObject({ image: digest });
    expect(config.containers[0]).not.toHaveProperty("image_vars");
    expect(config.assets.directory).toBe(assets);
    expect((await stat(`${assets}.tar.gz`)).isFile()).toBe(true);
  });

  it("refuses a build that lacks a recorded output rather than rebuilding it", async () => {
    const calls = runner();
    const r2 = fakeR2(seeded(record({ services: { api: { image: digest } } })));
    const { code, stderr } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": project },
      env,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "build abc123 has no recorded outputs for web; nothing is rebuilt during promotion\n",
    );
    expect(calls).not.toHaveBeenCalled();
  });

  it("refuses a recorded backend without an image instead of building one", async () => {
    const calls = runner();
    const r2 = fakeR2({
      ...seeded(
        record({
          services: {
            api: {},
            web: { assets: "acme/builds/abc123/web.tar.gz" },
          },
        }),
      ),
      "acme/builds/abc123/web.tar.gz": "archive",
    });
    const { code, stderr } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": project },
      env,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("build abc123 has no recorded image for api");
    expect(calls.mock.calls.map(([command]) => command)).not.toContain(
      "docker",
    );
    expect(calls.mock.calls.map(([, args]) => args[1])).not.toContain("deploy");
  });

  it("prints the build it would promote and changes nothing with --choose", async () => {
    const calls = runner();
    const r2 = fakeR2(seeded(record({})));
    const { code, stdout } = await run(
      ["promote", "--env", "production", "--choose"],
      { "turbo-vibe.yaml": project },
      env,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(stdout).toBe("abc123\n");
    expect(calls).not.toHaveBeenCalled();
  });

  it("refuses a confirmation that is not the build it would promote, and names that build", async () => {
    const calls = runner();
    const r2 = fakeR2(seeded(record({})));
    const { code, stdout, stderr } = await run(
      ["promote", "--env", "production", "--choose", "--confirm", "abc12"],
      { "turbo-vibe.yaml": project },
      env,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      'the build to promote is abc123, not "abc12"; production is unchanged. Confirm with abc123 to promote it\n',
    );
    expect(calls).not.toHaveBeenCalled();
  });

  it("accepts the confirmed build", async () => {
    const r2 = fakeR2(seeded(record({})));
    const { code, stdout } = await run(
      ["promote", "--env", "production", "--choose", "--confirm", " abc123 "],
      { "turbo-vibe.yaml": project },
      env,
      runner(),
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(stdout).toBe("abc123\n");
  });

  it("promotes a build whose ID was confirmed", async () => {
    const calls = runner();
    const r2 = fakeR2({
      ...seeded(record({})),
      "acme/builds/abc123/web.tar.gz": "archive",
    });
    const { code, stdout } = await run(
      [
        "promote",
        "--env",
        "production",
        "--build-id",
        "abc123",
        "--confirm",
        "abc123",
      ],
      { "turbo-vibe.yaml": project },
      env,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("promote build abc123 to production");
    expect(calls.mock.calls.map(([, args]) => args[1])).toContain("deploy");
  });

  it("promotes exactly the pinned build, even when a newer one has passed since", async () => {
    const r2 = fakeR2({
      ...seeded(
        record({}),
        record({ buildId: "new999", createdAt: "2026-10-08T12:00:00.000Z" }),
      ),
      "acme/builds/abc123/web.tar.gz": "archive",
    });
    const { code, stdout } = await run(
      ["promote", "--env", "production", "--build-id", "abc123"],
      { "turbo-vibe.yaml": project },
      env,
      runner(),
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("promote build abc123 to production");
  });

  it.each([
    [
      "failed",
      "build abc123 has not passed its smoke test (failed); production is unchanged\n",
    ],
    [
      "pending",
      "build abc123 has not passed its smoke test (pending); production is unchanged\n",
    ],
  ] as const)(
    "refuses a pinned build whose smoke test %s",
    async (smoke, message) => {
      const calls = runner();
      const { code, stderr } = await run(
        ["promote", "--env", "production", "--build-id", "abc123"],
        { "turbo-vibe.yaml": project },
        env,
        calls,
        fakeR2(seeded(record({ smoke }))).fetch(),
      );
      expect(code).toBe(1);
      expect(stderr).toBe(message);
      expect(calls).not.toHaveBeenCalled();
    },
  );

  it("refuses a pinned build with no record", async () => {
    const { code, stderr } = await run(
      ["promote", "--env", "production", "--build-id", "nope"],
      { "turbo-vibe.yaml": project },
      env,
      runner(),
      fakeR2().fetch(),
    );
    expect(code).toBe(1);
    expect(stderr).toBe("build nope has no record; production is unchanged\n");
  });

  it("only promotes to production", async () => {
    const { code, stderr } = await run(
      ["promote", "--env", "staging"],
      { "turbo-vibe.yaml": project },
      env,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "promote deploys to production; staging is deployed on every merge\n",
    );
  });
});

describe("runtime secrets", () => {
  async function deployCapturingSecrets(
    config: string,
    extraEnv: Record<string, string>,
    outputs = {},
  ) {
    const uploaded: unknown[] = [];
    const modes: number[] = [];
    const calls = runner((_command, args) => {
      const index = args.indexOf("--secrets-file");
      if (index >= 0) {
        const file = args[index + 1] as string;
        void readFile(file, "utf8").then((body) =>
          uploaded.push(JSON.parse(body)),
        );
        void stat(file).then((info) => modes.push(info.mode & 0o777));
      }
      return undefined;
    });
    const result = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": config },
      { ...env, ...extraEnv },
      calls,
      fakeR2().fetch(),
      { capture: capturing(outputs) },
    );
    return { ...result, uploaded, modes, calls };
  }

  it("gives backends the runtime role's session-pooler connection, then removes the file", async () => {
    const withDb = `${project}  db:
    kind: database
    target: supabase
    organization: acme-org
    region: eu-central-1
`;
    const { code, cwd, uploaded, modes, stdout, stderr } =
      await deployCapturingSecrets(
        withDb,
        {},
        {
          supabase_db_connection: {
            value: {
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
            },
          },
        },
      );
    expect(code).toBe(0);
    expect(uploaded).toEqual([
      {
        DATABASE_URL:
          "postgresql://turbo_vibe_runtime.abcdefghij:runpw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require",
      },
    ]);
    expect(modes).toEqual([0o600]);
    const workerDir = join(
      cwd,
      ".turbo-vibe",
      "wrangler",
      "staging",
      "acme-api-staging",
    );
    await expect(stat(join(workerDir, "secrets.json"))).rejects.toThrow();
    expect(await readFile(join(workerDir, "worker.js"), "utf8")).toContain(
      "DATABASE_URL: env.DATABASE_URL",
    );
    expect(await readFile(join(workerDir, "routing.js"), "utf8")).toContain(
      "export function instanceName(request)",
    );
    expect(stdout + stderr).not.toContain("runpw");
  });

  it("gives the backend the WorkOS client ID, key and callback, and the frontend build none of them", async () => {
    const withAuth = `${project}  auth:
    kind: identity
    target: workos
`;
    const { code, uploaded, calls, stdout, stderr } =
      await deployCapturingSecrets(withAuth, {
        WORKOS_API_KEY: "sk_test_s3cr3t",
        WORKOS_CLIENT_ID: "client_123",
      });
    expect(code).toBe(0);
    expect(uploaded).toEqual([
      {
        WORKOS_CLIENT_ID: "client_123",
        WORKOS_API_KEY: "sk_test_s3cr3t",
        WORKOS_REDIRECT_URI:
          "https://staging.acme.example.com/api/auth/callback",
      },
    ]);
    expect(calls.mock.calls[0]?.[2].env).toEqual({ BUILD_ID: "abc123" });
    expect(stdout + stderr).not.toContain("sk_test");
  });

  it("names missing WorkOS credentials before building anything", async () => {
    const calls = runner();
    const { code, stderr } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      {
        "turbo-vibe.yaml": `${project}  auth:\n    kind: identity\n    target: workos\n`,
      },
      { ...env, WORKOS_CLIENT_ID: "client_123" },
      calls,
    );
    expect(code).toBe(1);
    expect(stderr).toBe("missing environment variables: WORKOS_API_KEY\n");
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("a project with a database", () => {
  const withDb = `${project}  db:
    kind: database
    target: supabase
    organization: acme-org
    region: eu-central-1
`;

  it("needs no state credentials or OpenTofu outputs for a dry run", async () => {
    const calls = runner();
    const capture = capturing();
    const { code } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123", "--dry-run"],
      { "turbo-vibe.yaml": withDb },
      {},
      calls,
      undefined,
      { capture },
    );
    expect(code).toBe(0);
    expect(calls.mock.calls.some(([command]) => command === "tofu")).toBe(
      false,
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("smoke-checks only the services that ship builds", async () => {
    const r2 = fakeR2(seeded(record({ smoke: "pending" })));
    const { code, stdout } = await run(
      ["smoke", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": withDb },
      stateEnv,
      undefined,
      r2.fetch((url) =>
        url.endsWith("/api/health")
          ? Response.json({ build_id: "abc123" })
          : new Response("abc123"),
      ),
    );
    expect(code).toBe(0);
    expect(stdout).not.toContain("db:");
  });
});

describe("vercel-static", () => {
  const site = `version: 1
project: acme
domain: acme.example.com
services:
  web:
    kind: frontend
    target: vercel-static
    build: { command: "pnpm build", output: dist }
`;
  const vercelEnv = {
    ...stateEnv,
    CLOUDFLARE_API_TOKEN: "t",
    CLOUDFLARE_ZONE_ID: "z",
    VERCEL_API_TOKEN: "vercel-s3cr3t",
    VERCEL_TEAM_ID: "team_123",
  };
  const outputs = (environment: string) => ({
    vercel_project_ids: {
      value: { [`acme-web-${environment}`]: `prj_${environment}` },
    },
  });

  it("ships the CI build as a prebuilt static output to the environment's project, and records the files", async () => {
    const r2 = fakeR2();
    const calls = runner();
    const { code, cwd } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": site },
      vercelEnv,
      calls,
      r2.fetch(),
      { capture: capturing(outputs("staging")) },
    );
    expect(code).toBe(0);
    const root = join(cwd, ".turbo-vibe", "wrangler", "staging", "web-vercel");
    const deployCall = calls.mock.calls.find(([, args]) =>
      args.includes("--prebuilt"),
    );
    expect(deployCall?.[1].slice(1)).toEqual([
      "deploy",
      "--prebuilt",
      "--prod",
      "--yes",
    ]);
    expect(deployCall?.[2].cwd).toBe(root);
    expect(deployCall?.[2].env).toMatchObject({
      VERCEL_TOKEN: "vercel-s3cr3t",
      VERCEL_ORG_ID: "team_123",
      VERCEL_PROJECT_ID: "prj_staging",
    });
    expect(deployCall?.[1].join(" ")).not.toContain("s3cr3t");
    expect(
      JSON.parse(
        await readFile(join(root, ".vercel", "output", "config.json"), "utf8"),
      ),
    ).toEqual({ version: 3 });
    expect(
      await readFile(
        join(root, ".vercel", "output", "static", "_turbo-vibe", "build-id"),
        "utf8",
      ),
    ).toBe("abc123");
    expect(r2.record("acme/builds/abc123.json").services).toEqual({
      web: { assets: "acme/builds/abc123/web.tar.gz" },
    });
  });

  it("prepares the output but uploads nothing in a dry run", async () => {
    const calls = runner();
    const { code } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123", "--dry-run"],
      { "turbo-vibe.yaml": site },
      {},
      calls,
    );
    expect(code).toBe(0);
    expect(calls.mock.calls.map(([command]) => command)).toEqual(["sh"]);
  });

  it("asks for apply when the environment has no Vercel project yet", async () => {
    const calls = runner();
    const { code, stderr } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": site },
      vercelEnv,
      calls,
      fakeR2().fetch(),
      { capture: capturing({}) },
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "no Vercel project for web in staging; run apply first",
    );
    expect(
      calls.mock.calls.some(([, args]) => args.includes("--prebuilt")),
    ).toBe(false);
  });

  it("promotes the recorded files to the production project without building", async () => {
    const calls = runner();
    const r2 = fakeR2({
      ...seeded(
        record({
          services: { web: { assets: "acme/builds/abc123/web.tar.gz" } },
        }),
      ),
      "acme/builds/abc123/web.tar.gz": "archive",
    });
    const { code } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": site },
      vercelEnv,
      calls,
      r2.fetch(),
      { capture: capturing(outputs("production")) },
    );
    expect(code).toBe(0);
    expect(calls.mock.calls.map(([command]) => command)).not.toContain("sh");
    const deployCall = calls.mock.calls.find(([, args]) =>
      args.includes("--prebuilt"),
    );
    expect(deployCall?.[2].env).toMatchObject({
      VERCEL_PROJECT_ID: "prj_production",
    });
  });

  it("smoke-checks the build ID on the environment's hostname", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("abc123"),
    );
    const { code } = await run(
      ["smoke", "--env", "production", "--build-id", "abc123"],
      { "turbo-vibe.yaml": site },
      {},
      undefined,
      fetch,
    );
    expect(code).toBe(0);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://acme.example.com/_turbo-vibe/build-id",
    ]);
  });
});

describe("a Vercel frontend with a Cloudflare backend", () => {
  const split = `version: 1
project: acme
domain: acme.example.com
services:
  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile }
  web:
    kind: frontend
    target: vercel-static
    build: { command: "pnpm build", output: dist }
`;
  const splitEnv = {
    ...env,
    VERCEL_API_TOKEN: "v",
    VERCEL_TEAM_ID: "team_123",
  };
  const outputs = (environment: string) => ({
    vercel_project_ids: {
      value: { [`acme-web-${environment}`]: `prj_${environment}` },
    },
  });

  it("gives the backend its exact allowed origin and cookie domain, and the page its backend URL", async () => {
    const uploaded: unknown[] = [];
    const calls = runner(async (_command, args) => {
      const index = args.indexOf("--secrets-file");
      if (index >= 0)
        uploaded.push(
          JSON.parse(await readFile(args[index + 1] as string, "utf8")),
        );
      return undefined;
    });
    const { code, cwd } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": split },
      splitEnv,
      calls,
      fakeR2().fetch(),
      { capture: capturing(outputs("staging")) },
    );
    expect(code).toBe(0);
    expect(uploaded).toEqual([
      {
        ALLOWED_ORIGINS: "https://staging.acme.example.com",
        FRONTEND_URL: "https://staging.acme.example.com",
        COOKIE_DOMAIN: "staging.acme.example.com",
      },
    ]);
    const config = JSON.parse(
      await readFile(
        join(
          cwd,
          ".turbo-vibe",
          "wrangler",
          "staging",
          "web-vercel",
          ".vercel",
          "output",
          "static",
          "_turbo-vibe",
          "config.json",
        ),
        "utf8",
      ),
    );
    expect(config).toEqual({ apiUrl: "https://api.staging.acme.example.com" });
    expect(
      await workerConfig(cwd, "staging", "acme-api-staging"),
    ).not.toHaveProperty("assets");
  });

  it("points the promoted page at production's backend without rebuilding it", async () => {
    const r2 = fakeR2({
      ...seeded(record({})),
      "acme/builds/abc123/web.tar.gz": "archive",
    });
    const { code, cwd } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": split },
      splitEnv,
      runner(),
      r2.fetch(),
      { capture: capturing(outputs("production")) },
    );
    expect(code).toBe(0);
    const config = JSON.parse(
      await readFile(
        join(
          cwd,
          ".turbo-vibe",
          "wrangler",
          "production",
          "web-vercel",
          ".vercel",
          "output",
          "static",
          "_turbo-vibe",
          "config.json",
        ),
        "utf8",
      ),
    );
    expect(config).toEqual({ apiUrl: "https://api.acme.example.com" });
  });
});

describe("vercel-nextjs", () => {
  const app = `version: 1
project: acme
domain: acme.example.com
services:
  web:
    kind: frontend
    target: vercel-nextjs
    build: { command: "npm ci", root: app }
`;
  const vercelEnv = {
    ...stateEnv,
    CLOUDFLARE_API_TOKEN: "t",
    CLOUDFLARE_ZONE_ID: "z",
    VERCEL_API_TOKEN: "vercel-s3cr3t",
    VERCEL_TEAM_ID: "team_123",
  };
  const outputs = (environment: string) => ({
    vercel_project_ids: {
      value: { [`acme-web-${environment}`]: `prj_${environment}` },
    },
  });

  it("builds once with vercel build in CI, without credentials, and ships and records that output", async () => {
    const r2 = fakeR2();
    let linkDuringBuild: unknown;
    const calls = runner(async (_command, args, options) => {
      if (args.includes("build")) {
        linkDuringBuild = JSON.parse(
          await readFile(join(options.cwd, ".vercel", "project.json"), "utf8"),
        );
      }
      return undefined;
    });
    const { code, cwd } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123"],
      { "turbo-vibe.yaml": app },
      vercelEnv,
      calls,
      r2.fetch(),
      { capture: capturing(outputs("staging")) },
    );
    expect(code).toBe(0);
    const root = join(cwd, "app");
    const [install, build] = calls.mock.calls.filter(
      ([command]) => command !== "tofu",
    );
    expect(install?.slice(0, 2)).toEqual(["sh", ["-c", "npm ci"]]);
    expect(install?.[2].cwd).toBe(root);
    expect(build?.[1].slice(1)).toEqual([
      "build",
      "--prod",
      "--yes",
      "--standalone",
    ]);
    expect(build?.[2]).toMatchObject({
      cwd: root,
      env: { BUILD_ID: "abc123", VERCEL_TELEMETRY_DISABLED: "1" },
    });
    expect(build?.[2].env).not.toHaveProperty("VERCEL_API_TOKEN");
    expect(linkDuringBuild).toMatchObject({
      settings: { framework: "nextjs" },
    });
    await expect(stat(join(root, ".vercel", "project.json"))).rejects.toThrow();
    expect(
      await readFile(
        join(root, ".vercel", "output", "static", "_turbo-vibe", "build-id"),
        "utf8",
      ),
    ).toBe("abc123");
    const deployCall = calls.mock.calls.find(([, args]) =>
      args.includes("--prebuilt"),
    );
    expect(deployCall?.[2].env).toMatchObject({
      VERCEL_PROJECT_ID: "prj_staging",
    });
    expect(r2.record("acme/builds/abc123.json").services).toEqual({
      web: { assets: "acme/builds/abc123/web.tar.gz" },
    });
  });

  it("puts back the app's own vercel link file after building", async () => {
    const mine = '{"projectId":"prj_mine","orgId":"team_mine"}\n';
    const { code, cwd } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123", "--dry-run"],
      { "turbo-vibe.yaml": app },
      {},
      runner(),
      undefined,
      {},
      { "app/.vercel/project.json": mine },
    );
    expect(code).toBe(0);
    expect(
      await readFile(join(cwd, "app", ".vercel", "project.json"), "utf8"),
    ).toBe(mine);
  });

  it("reuses the recorded output at promotion and never builds again", async () => {
    const calls = runner();
    const r2 = fakeR2({
      ...seeded(
        record({
          services: { web: { assets: "acme/builds/abc123/web.tar.gz" } },
        }),
      ),
      "acme/builds/abc123/web.tar.gz": "archive",
    });
    const { code } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": app },
      vercelEnv,
      calls,
      r2.fetch(),
      { capture: capturing(outputs("production")) },
    );
    expect(code).toBe(0);
    expect(
      calls.mock.calls
        .filter(([command]) => command !== "tofu")
        .map(([command, args]) => [command, args[1]]),
    ).toEqual([
      ["tar", expect.stringContaining("web-assets.tar.gz")],
      [process.execPath, "deploy"],
    ]);
    const deployCall = calls.mock.calls.find(([, args]) =>
      args.includes("--prebuilt"),
    );
    expect(deployCall?.[2].env).toMatchObject({
      VERCEL_PROJECT_ID: "prj_production",
    });
  });

  it("builds but ships nothing in a dry run", async () => {
    const calls = runner();
    const { code } = await run(
      ["deploy", "--env", "staging", "--build-id", "abc123", "--dry-run"],
      { "turbo-vibe.yaml": app },
      {},
      calls,
    );
    expect(code).toBe(0);
    expect(calls.mock.calls.map(([, args]) => args[1])).toEqual([
      "npm ci",
      "build",
    ]);
  });
});
