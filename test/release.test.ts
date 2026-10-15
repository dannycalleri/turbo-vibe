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
const production = { ...env, TURBO_VIBE_BUILDS_BUCKET: "tv-state" };
const record = (overrides: Partial<BuildRecord>): BuildRecord => ({
  buildId: "abc1230000000000000000000000000000000000",
  createdAt: "2026-10-08T10:00:00.000Z",
  smoke: "passed",
  services: {
    api: { image: digest },
    web: {
      assets: "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz",
    },
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
    const fetch = r2.fetch();
    const { code, cwd, stdout } = await run(
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
      { "turbo-vibe.yaml": project },
      env,
      calls,
      fetch,
      { capture: capturing() },
    );
    expect(code).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(
        /\/containers\/applications\?name=acme-api-staging-backend$/,
      ),
      expect.anything(),
    );
    expect(stdout).toContain(
      "acme-api-staging-backend: every instance runs the new image\n",
    );
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
    expect(calls.mock.calls[0]?.[2].env).toEqual({
      BUILD_ID: "abc1230000000000000000000000000000000000",
    });
    expect(calls.mock.calls[2]?.[1]).toContain(
      "BUILD_ID=abc1230000000000000000000000000000000000",
    );
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
    ).toBe("abc1230000000000000000000000000000000000");

    expect(
      r2.objects.has(
        "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz",
      ),
    ).toBe(true);
    expect(
      r2.record("acme/builds/abc1230000000000000000000000000000000000.json"),
    ).toEqual({
      buildId: "abc1230000000000000000000000000000000000",
      createdAt: expect.any(String),
      smoke: "pending",
      services: {
        web: {
          assets:
            "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz",
        },
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
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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
    expect(
      r2.record("acme/builds/abc1230000000000000000000000000000000000.json")
        .services,
    ).toEqual({
      web: {
        assets:
          "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz",
      },
    });
  });

  describe("checks in a dry run that the container answers its health route and stops on SIGTERM", () => {
    const buildId = "abc1230000000000000000000000000000000000";
    const healthUrl = "http://127.0.0.1:55001/api/health";

    function container(running: string, exitCode: string) {
      return vi.fn(async (_command: string, args: readonly string[]) => ({
        code: 0,
        stdout:
          args[0] === "run"
            ? "c0ffee\n"
            : args[0] === "port"
              ? "127.0.0.1:55001\n"
              : args.includes("{{.State.Running}}")
                ? `${running}\n`
                : `${exitCode}\n`,
      }));
    }

    const answering = (body: string) =>
      vi.fn(async () => new Response(body, { status: 200 }));

    async function dryRun(
      capture: ReturnType<typeof container>,
      fetch: typeof globalThis.fetch = answering(
        JSON.stringify({ build_id: buildId, status: "ok" }),
      ),
    ) {
      const calls = runner();
      const result = await run(
        ["deploy", "--env", "staging", "--build-id", buildId, "--dry-run"],
        { "turbo-vibe.yaml": project },
        {},
        calls,
        fetch,
        { capture },
      );
      return { ...result, calls, capture };
    }

    it("passes a container that reports the build and exits on SIGTERM, and removes it", async () => {
      const capture = container("true", "0");
      const fetch = answering(
        JSON.stringify({ build_id: buildId, status: "ok" }),
      );
      const { code, stdout, calls } = await dryRun(capture, fetch);
      expect(code).toBe(0);
      expect(stdout).toContain(
        `api: the container answers /api/health with build ${buildId}\n`,
      );
      expect(stdout).toContain("api: the container stops on SIGTERM\n");
      expect(stdout).toContain(
        "dry run passed: every service built and checked; nothing was uploaded\n",
      );
      expect(capture).toHaveBeenCalledWith(
        "docker",
        [
          "run",
          "--detach",
          "--platform",
          "linux/amd64",
          "--env",
          "PORT=8080",
          "--publish",
          "127.0.0.1::8080",
          `acme-api:${buildId}`,
        ],
        expect.anything(),
      );
      expect(fetch).toHaveBeenCalledWith(healthUrl, expect.anything());
      expect(capture).toHaveBeenCalledWith(
        "docker",
        ["stop", "--timeout", "10", "c0ffee"],
        expect.anything(),
      );
      expect(capture).toHaveBeenCalledWith(
        "docker",
        ["rm", "--force", "c0ffee"],
        expect.anything(),
      );
    });

    it.each([
      [
        "reports another build",
        answering(JSON.stringify({ build_id: "local" })),
        `${healthUrl} reports build local, expected ${buildId}`,
      ],
      [
        "answers without JSON",
        answering("ok"),
        `${healthUrl} reports build (none), expected ${buildId}`,
      ],
      [
        "does not answer",
        vi.fn(async () => {
          throw new Error("connection refused");
        }),
        `${healthUrl} unreachable: connection refused`,
      ],
    ])(
      "fails a container whose health route %s, says how to fix it, and removes it",
      async (_case, fetch, problem) => {
        const { code, stderr, calls, capture } = await dryRun(
          container("true", "0"),
          fetch as typeof globalThis.fetch,
        );
        expect(code).toBe(1);
        expect(stderr).toContain(
          `api: ${problem}. The smoke test after every deploy asks GET /api/health on port 8080`,
        );
        expect(stderr).toContain("ARG BUILD_ID and ENV BUILD_ID=$BUILD_ID");
        expect(capture).not.toHaveBeenCalledWith(
          "docker",
          expect.arrayContaining(["stop"]),
          expect.anything(),
        );
        expect(
          calls.mock.calls.some(([command]) => command === process.execPath),
        ).toBe(false);
        expect(capture).toHaveBeenCalledWith(
          "docker",
          ["rm", "--force", "c0ffee"],
          expect.anything(),
        );
      },
    );

    it("stops without probing when the container published no port", async () => {
      const base = container("true", "0");
      const capture = vi.fn(async (command: string, args: readonly string[]) =>
        args[0] === "port" ? { code: 1, stdout: "" } : base(command, args),
      );
      const fetch = answering("{}");
      const { code, stderr } = await dryRun(capture, fetch);
      expect(code).toBe(1);
      expect(stderr).toContain(
        "api: the container published no port for 8080, so its health route is not reachable",
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(capture).toHaveBeenCalledWith(
        "docker",
        ["rm", "--force", "c0ffee"],
        expect.anything(),
      );
    });

    it("fails a container docker had to kill, before wrangler runs, and still removes it", async () => {
      const { code, stderr, calls, capture } = await dryRun(
        container("true", "137"),
      );
      expect(code).toBe(1);
      expect(stderr).toContain(
        "api: the container ignored SIGTERM and was killed after 10 seconds.",
      );
      expect(
        calls.mock.calls.some(([command]) => command === process.execPath),
      ).toBe(false);
      expect(capture).toHaveBeenCalledWith(
        "docker",
        ["rm", "--force", "c0ffee"],
        expect.anything(),
      );
    });

    it("says it could not check a container that exited by itself, and goes on", async () => {
      const { code, stdout, capture } = await dryRun(container("false", "1"));
      expect(code).toBe(0);
      expect(stdout).toContain(
        "api: the container exited by itself within 3 seconds, so its health route and whether it stops on SIGTERM are not checked\n",
      );
      expect(stdout).toContain(
        "dry run passed: every service built, but api could not be checked (see above); nothing was uploaded\n",
      );
      expect(capture).not.toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["stop"]),
        expect.anything(),
      );
    });
  });

  it("builds and validates without credentials, uploads, or a record in a dry run", async () => {
    const calls = runner();
    const r2 = fakeR2();
    const { code, cwd, stdout } = await run(
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
        "--dry-run",
      ],
      { "turbo-vibe.yaml": project },
      {},
      calls,
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(calls.mock.calls.map(([command]) => command)).toEqual([
      "sh",
      "docker",
      process.execPath,
    ]);
    expect(calls.mock.calls[2]?.[1]).toContain("--dry-run");
    expect(stdout).toContain(
      "dry run passed: every service built, but api could not be checked (see above); nothing was uploaded\n",
    );
    expect(
      (await workerConfig(cwd, "staging", "acme-api-staging")).containers[0],
    ).toMatchObject({
      image: join(cwd, "Dockerfile"),
      image_vars: { BUILD_ID: "abc1230000000000000000000000000000000000" },
    });
    expect(r2.objects.size).toBe(0);
  });

  it("names every missing credential, the state bucket's included, and runs nothing", async () => {
    const calls = runner();
    const { code, stderr } = await run(
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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
    expect(
      r2.record("acme/builds/abc1230000000000000000000000000000000000.json")
        .services.api,
    ).toEqual({
      image: digest,
    });
  });

  it("fails when the pushed image has no registry digest", async () => {
    const r2 = fakeR2();
    const { code, stderr } = await run(
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
      { "turbo-vibe.yaml": project },
      env,
      runner(),
      r2.fetch(),
      { capture: capturing({}, ["acme-api@sha256:local"]) },
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "cannot find the pushed digest of acme-api:abc1230000000000000000000000000000000000 in the Cloudflare registry",
    );
    expect(
      r2.objects.has(
        "acme/builds/abc1230000000000000000000000000000000000.json",
      ),
    ).toBe(false);
  });

  it("refuses production: production only receives promoted builds", async () => {
    const calls = runner();
    const { code, stderr } = await run(
      [
        "deploy",
        "--env",
        "production",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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
      [
        "smoke",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
      { "turbo-vibe.yaml": project },
      stateEnv,
      undefined,
      r2.fetch(serving("abc1230000000000000000000000000000000000")),
    );
    expect(code).toBe(0);
    expect(stdout).toBe(
      "ok api: https://staging.acme.example.com/api/health reports build abc1230000000000000000000000000000000000\n" +
        "ok web: https://staging.acme.example.com/_turbo-vibe/build-id reports build abc1230000000000000000000000000000000000\n",
    );
    expect(
      r2.record("acme/builds/abc1230000000000000000000000000000000000.json")
        .smoke,
    ).toBe("passed");
  });

  it("records a failing staging build and names both build IDs", async () => {
    const r2 = fakeR2(seeded(record({ smoke: "pending" })));
    const { code, stderr } = await run(
      [
        "smoke",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
      { "turbo-vibe.yaml": project },
      stateEnv,
      undefined,
      r2.fetch(serving("old999", "abc1230000000000000000000000000000000000")),
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "FAIL api: https://staging.acme.example.com/api/health reports build old999, expected abc1230000000000000000000000000000000000\n",
    );
    expect(
      r2.record("acme/builds/abc1230000000000000000000000000000000000.json")
        .smoke,
    ).toBe("failed");
  });

  it("reports a malformed health body as no build rather than an unreachable service", async () => {
    const r2 = fakeR2(seeded(record({ smoke: "pending" })));
    const { stderr } = await run(
      [
        "smoke",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
      { "turbo-vibe.yaml": project },
      stateEnv,
      undefined,
      r2.fetch((url) =>
        url.endsWith("/api/health")
          ? new Response("OK")
          : new Response("abc1230000000000000000000000000000000000"),
      ),
    );
    expect(stderr).toContain(
      "reports build (none), expected abc1230000000000000000000000000000000000",
    );
  });

  it("fails a staging build that has no record, since it could never be promoted", async () => {
    const { code, stderr } = await run(
      [
        "smoke",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
      { "turbo-vibe.yaml": project },
      stateEnv,
      undefined,
      fakeR2().fetch(serving("abc1230000000000000000000000000000000000")),
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "no build record for abc1230000000000000000000000000000000000; it cannot be promoted\n",
    );
  });

  it("checks production without touching build records", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) =>
      serving("abc1230000000000000000000000000000000000")(String(input)),
    );
    const { code } = await run(
      [
        "smoke",
        "--env",
        "production",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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
      production,
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
      "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz":
        "archive",
    });
    const { code, cwd, stdout } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": project },
      production,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "promote build abc1230000000000000000000000000000000000 to production",
    );
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
      production,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "build abc1230000000000000000000000000000000000 has no recorded outputs for web; nothing is rebuilt during promotion\n",
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
            web: {
              assets:
                "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz",
            },
          },
        }),
      ),
      "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz":
        "archive",
    });
    const { code, stderr } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": project },
      production,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(1);
    expect(stderr).toContain(
      "build abc1230000000000000000000000000000000000 has no recorded image for api",
    );
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
      production,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(stdout).toBe("abc1230000000000000000000000000000000000\n");
    expect(calls).not.toHaveBeenCalled();
  });

  it("reads build records from staging's bucket and writes nothing there", async () => {
    const r2 = fakeR2(seeded(record({})));
    const fetch = r2.fetch();
    const { code, stdout } = await run(
      ["promote", "--env", "production", "--choose"],
      { "turbo-vibe.yaml": project },
      { ...production, TURBO_VIBE_STATE_BUCKET: "prod-state" },
      runner(),
      fetch,
    );
    expect(code).toBe(0);
    expect(stdout).toBe("abc1230000000000000000000000000000000000\n");
    const storage = fetch.mock.calls
      .map(([input]) => input as Request)
      .filter((request) => request.url.includes("r2.cloudflarestorage.com"));
    expect(storage.length).toBeGreaterThan(0);
    for (const request of storage) {
      expect(new URL(request.url).pathname).toMatch(/^\/tv-state\//);
      expect(request.method).toBe("GET");
    }
  });

  it("names a missing builds bucket before it reads anything", async () => {
    const calls = runner();
    const fetch = fakeR2(seeded(record({}))).fetch();
    const { TURBO_VIBE_BUILDS_BUCKET: _, ...withoutBuilds } = production;
    const { code, stderr } = await run(
      ["promote", "--env", "production", "--choose"],
      { "turbo-vibe.yaml": project },
      withoutBuilds,
      calls,
      fetch,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "missing environment variables: TURBO_VIBE_BUILDS_BUCKET\n",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
  });

  it.each([
    ["a short SHA", "abc1230"],
    ["text that would write a workflow output", 'abc" >> out; echo "x'],
  ])(
    "refuses a chosen record whose build ID is %s, before printing it",
    async (_, buildId) => {
      const r2 = fakeR2(seeded(record({ buildId })));
      const { code, stdout, stderr } = await run(
        ["promote", "--env", "production", "--choose"],
        { "turbo-vibe.yaml": project },
        production,
        runner(),
        r2.fetch(),
      );
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe(
        `the build record names ${JSON.stringify(buildId)} as its build, which is not a full commit SHA; production is unchanged\n`,
      );
    },
  );

  it("refuses a confirmation that is not the build it would promote, and names that build", async () => {
    const calls = runner();
    const r2 = fakeR2(seeded(record({})));
    const { code, stdout, stderr } = await run(
      ["promote", "--env", "production", "--choose", "--confirm", "abc12"],
      { "turbo-vibe.yaml": project },
      production,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      'the build to promote is abc1230000000000000000000000000000000000, not "abc12"; production is unchanged. Confirm with abc1230000000000000000000000000000000000 to promote it\n',
    );
    expect(calls).not.toHaveBeenCalled();
  });

  it("accepts the confirmed build", async () => {
    const r2 = fakeR2(seeded(record({})));
    const { code, stdout } = await run(
      [
        "promote",
        "--env",
        "production",
        "--choose",
        "--confirm",
        " abc1230000000000000000000000000000000000 ",
      ],
      { "turbo-vibe.yaml": project },
      production,
      runner(),
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(stdout).toBe("abc1230000000000000000000000000000000000\n");
  });

  it("promotes a build whose ID was confirmed", async () => {
    const calls = runner();
    const r2 = fakeR2({
      ...seeded(record({})),
      "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz":
        "archive",
    });
    const { code, stdout } = await run(
      [
        "promote",
        "--env",
        "production",
        "--build-id",
        "abc1230000000000000000000000000000000000",
        "--confirm",
        "abc1230000000000000000000000000000000000",
      ],
      { "turbo-vibe.yaml": project },
      production,
      calls,
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "promote build abc1230000000000000000000000000000000000 to production",
    );
    expect(calls.mock.calls.map(([, args]) => args[1])).toContain("deploy");
  });

  it("promotes exactly the pinned build, even when a newer one has passed since", async () => {
    const r2 = fakeR2({
      ...seeded(
        record({}),
        record({ buildId: "new999", createdAt: "2026-10-08T12:00:00.000Z" }),
      ),
      "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz":
        "archive",
    });
    const { code, stdout } = await run(
      [
        "promote",
        "--env",
        "production",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
      { "turbo-vibe.yaml": project },
      production,
      runner(),
      r2.fetch(),
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "promote build abc1230000000000000000000000000000000000 to production",
    );
  });

  it.each([
    [
      "failed",
      "build abc1230000000000000000000000000000000000 has not passed its smoke test (failed); production is unchanged\n",
    ],
    [
      "pending",
      "build abc1230000000000000000000000000000000000 has not passed its smoke test (pending); production is unchanged\n",
    ],
  ] as const)(
    "refuses a pinned build whose smoke test %s",
    async (smoke, message) => {
      const calls = runner();
      const { code, stderr } = await run(
        [
          "promote",
          "--env",
          "production",
          "--build-id",
          "abc1230000000000000000000000000000000000",
        ],
        { "turbo-vibe.yaml": project },
        production,
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
      production,
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
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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
    expect(calls.mock.calls[0]?.[2].env).toEqual({
      BUILD_ID: "abc1230000000000000000000000000000000000",
    });
    expect(stdout + stderr).not.toContain("sk_test");
  });

  const withSecrets = project.replace(
    "    target: cloudflare-container\n",
    "    target: cloudflare-container\n    secrets: [STRIPE_SECRET_KEY, POSTMARK_TOKEN]\n",
  );

  it("gives the backend its declared secrets, a plain variable over the JSON object, and no build any of them", async () => {
    const { code, cwd, uploaded, calls, stdout, stderr } =
      await deployCapturingSecrets(withSecrets, {
        STRIPE_SECRET_KEY: "sk_plain",
        TURBO_VIBE_SECRETS: JSON.stringify({
          STRIPE_SECRET_KEY: "sk_json",
          POSTMARK_TOKEN: "pm_json",
          UNDECLARED: "other",
        }),
      });
    expect(code).toBe(0);
    expect(uploaded).toEqual([
      { STRIPE_SECRET_KEY: "sk_plain", POSTMARK_TOKEN: "pm_json" },
    ]);
    const worker = await readFile(
      join(
        cwd,
        ".turbo-vibe",
        "wrangler",
        "staging",
        "acme-api-staging",
        "worker.js",
      ),
      "utf8",
    );
    expect(worker).toContain("STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY");
    expect(worker).toContain("POSTMARK_TOKEN: env.POSTMARK_TOKEN");
    expect(worker).not.toContain("UNDECLARED");
    expect(calls.mock.calls[0]?.[2].env).toEqual({
      BUILD_ID: "abc1230000000000000000000000000000000000",
    });
    const dockerBuild = calls.mock.calls.find(
      ([command, args]) => command === "docker" && args[0] === "build",
    );
    expect(dockerBuild?.[2].env).not.toHaveProperty("STRIPE_SECRET_KEY");
    expect(dockerBuild?.[2].env).not.toHaveProperty("TURBO_VIBE_SECRETS");
    expect(stdout + stderr).not.toMatch(/sk_|pm_json/);
  });

  it("names a declared secret with no value before building anything", async () => {
    const calls = runner();
    const { code, stderr } = await run(
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
      { "turbo-vibe.yaml": withSecrets },
      { ...env, STRIPE_SECRET_KEY: "sk_plain" },
      calls,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "staging has no value for POSTMARK_TOKEN, declared in turbo-vibe.yaml; store it in the staging GitHub environment with `setup --env staging`\n",
    );
    expect(calls).not.toHaveBeenCalled();
  });

  it("needs no value in a dry run", async () => {
    const { code } = await run(
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
        "--dry-run",
      ],
      { "turbo-vibe.yaml": withSecrets },
      {},
      runner(),
      undefined,
      { capture: capturing() },
    );
    expect(code).toBe(0);
  });

  it("records no value in the build record", async () => {
    const r2 = fakeR2();
    const { code } = await run(
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
      { "turbo-vibe.yaml": withSecrets },
      { ...env, STRIPE_SECRET_KEY: "sk_staging", POSTMARK_TOKEN: "pm_staging" },
      runner(),
      r2.fetch(),
      { capture: capturing() },
    );
    expect(code).toBe(0);
    expect(r2.objects.size).toBeGreaterThan(0);
    for (const body of r2.objects.values())
      expect(new TextDecoder().decode(body)).not.toMatch(
        /sk_staging|pm_staging/,
      );
  });

  it("promotes with production's values, and checks them only after choosing", async () => {
    const uploaded: unknown[] = [];
    const calls = runner((_command, args) => {
      const index = args.indexOf("--secrets-file");
      if (index >= 0)
        void readFile(args[index + 1] as string, "utf8").then((body) =>
          uploaded.push(JSON.parse(body)),
        );
      return undefined;
    });
    const r2 = () =>
      fakeR2({
        ...seeded(record({})),
        "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz":
          "archive",
      });
    const chosen = await run(
      ["promote", "--env", "production", "--choose"],
      { "turbo-vibe.yaml": withSecrets },
      production,
      runner(),
      r2().fetch(),
    );
    expect(chosen.code).toBe(0);
    const { code } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": withSecrets },
      {
        ...production,
        TURBO_VIBE_SECRETS: JSON.stringify({
          STRIPE_SECRET_KEY: "sk_live",
          POSTMARK_TOKEN: "pm_live",
        }),
      },
      calls,
      r2().fetch(),
    );
    expect(code).toBe(0);
    expect(uploaded).toEqual([
      { STRIPE_SECRET_KEY: "sk_live", POSTMARK_TOKEN: "pm_live" },
    ]);

    const untouched = runner();
    const missing = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": withSecrets },
      { ...production, STRIPE_SECRET_KEY: "sk_live" },
      untouched,
      r2().fetch(),
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe(
      "production has no value for POSTMARK_TOKEN, declared in turbo-vibe.yaml; store it in the production GitHub environment with `setup --env production`\n",
    );
    expect(untouched).not.toHaveBeenCalled();
  });

  it("names missing WorkOS credentials before building anything", async () => {
    const calls = runner();
    const { code, stderr } = await run(
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
        "--dry-run",
      ],
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
    expect(capture).not.toHaveBeenCalledWith(
      "tofu",
      expect.anything(),
      expect.anything(),
    );
  });

  it("smoke-checks only the services that ship builds", async () => {
    const r2 = fakeR2(seeded(record({ smoke: "pending" })));
    const { code, stdout } = await run(
      [
        "smoke",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
      { "turbo-vibe.yaml": withDb },
      stateEnv,
      undefined,
      r2.fetch((url) =>
        url.endsWith("/api/health")
          ? Response.json({
              build_id: "abc1230000000000000000000000000000000000",
            })
          : new Response("abc1230000000000000000000000000000000000"),
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
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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
    ).toBe("abc1230000000000000000000000000000000000");
    expect(
      r2.record("acme/builds/abc1230000000000000000000000000000000000.json")
        .services,
    ).toEqual({
      web: {
        assets:
          "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz",
      },
    });
  });

  it("prepares the output but uploads nothing in a dry run", async () => {
    const calls = runner();
    const { code } = await run(
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
        "--dry-run",
      ],
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
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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

  it("promotes the recorded files to the production project without building, reading them from staging's bucket only", async () => {
    const calls = runner();
    const r2 = fakeR2({
      ...seeded(
        record({
          services: {
            web: {
              assets:
                "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz",
            },
          },
        }),
      ),
      "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz":
        "archive",
    });
    const fetch = r2.fetch();
    const { code } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": site },
      {
        ...vercelEnv,
        TURBO_VIBE_STATE_BUCKET: "prod-state",
        TURBO_VIBE_BUILDS_BUCKET: "tv-state",
      },
      calls,
      fetch,
      { capture: capturing(outputs("production")) },
    );
    expect(code).toBe(0);
    const storage = fetch.mock.calls
      .map(([input]) => input as Request)
      .filter((request) => request.url.includes("r2.cloudflarestorage.com"));
    expect(storage.map((request) => new URL(request.url).pathname)).toContain(
      "/tv-state/acme/builds/abc1230000000000000000000000000000000000/web.tar.gz",
    );
    for (const request of storage) {
      expect(new URL(request.url).pathname).toMatch(/^\/tv-state\//);
      expect(request.method).toBe("GET");
    }
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
      async () => new Response("abc1230000000000000000000000000000000000"),
    );
    const { code } = await run(
      [
        "smoke",
        "--env",
        "production",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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

  it("gives the backend its exact allowed origin and no cookie domain, and the page its backend URL", async () => {
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
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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
      "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz":
        "archive",
    });
    const { code, cwd } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": split },
      { ...splitEnv, TURBO_VIBE_BUILDS_BUCKET: "tv-state" },
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
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
      ],
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
      env: {
        BUILD_ID: "abc1230000000000000000000000000000000000",
        VERCEL_TELEMETRY_DISABLED: "1",
      },
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
    ).toBe("abc1230000000000000000000000000000000000");
    const deployCall = calls.mock.calls.find(([, args]) =>
      args.includes("--prebuilt"),
    );
    expect(deployCall?.[2].env).toMatchObject({
      VERCEL_PROJECT_ID: "prj_staging",
    });
    expect(
      r2.record("acme/builds/abc1230000000000000000000000000000000000.json")
        .services,
    ).toEqual({
      web: {
        assets:
          "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz",
      },
    });
  });

  describe("its own secrets", () => {
    const withSecrets = app.replace(
      "    target: vercel-nextjs\n",
      "    target: vercel-nextjs\n    secrets: [OPENAI_API_KEY, STRIPE_SECRET_KEY]\n",
    );
    const values = {
      TURBO_VIBE_SECRETS: JSON.stringify({
        OPENAI_API_KEY: "sk-openai",
        STRIPE_SECRET_KEY: "sk_stripe",
      }),
    };
    const vercelApi = (failed: unknown[] = []) => {
      const order: string[] = [];
      const fetch = fakeR2().fetch((url) => {
        order.push(`api ${url}`);
        return Response.json({ created: {}, failed }, { status: 201 });
      });
      const calls = runner((_command, args) => {
        if (args.includes("--prebuilt")) order.push("vercel deploy --prebuilt");
        return undefined;
      });
      return { fetch, calls, order };
    };
    const deployStaging = (
      fetch: typeof globalThis.fetch,
      calls: ReturnType<typeof runner>,
      extra: string[] = [],
    ) =>
      run(
        [
          "deploy",
          "--env",
          "staging",
          "--build-id",
          "abc1230000000000000000000000000000000000",
          ...extra,
        ],
        { "turbo-vibe.yaml": withSecrets },
        { ...vercelEnv, ...values },
        calls,
        fetch,
        { capture: capturing(outputs("staging")) },
      );

    it("sets each one on the environment's Vercel project, as a sensitive production variable, before the output ships", async () => {
      const { fetch, calls, order } = vercelApi();
      const { code, stdout, stderr } = await deployStaging(fetch, calls);
      expect(code).toBe(0);
      const url =
        "https://api.vercel.com/v10/projects/prj_staging/env?upsert=true&teamId=team_123";
      expect(order).toEqual([
        `api ${url}`,
        `api ${url}`,
        "vercel deploy --prebuilt",
      ]);
      const sent = fetch.mock.calls
        .filter(([input]) => String(input).startsWith("https://api.vercel.com"))
        .map(([, init]) => ({
          method: init?.method,
          authorization: (init?.headers as Record<string, string> | undefined)
            ?.authorization,
          body: JSON.parse(String(init?.body)),
        }));
      expect(sent).toEqual([
        {
          method: "POST",
          authorization: "Bearer vercel-s3cr3t",
          body: {
            key: "OPENAI_API_KEY",
            value: "sk-openai",
            type: "sensitive",
            target: ["production"],
          },
        },
        {
          method: "POST",
          authorization: "Bearer vercel-s3cr3t",
          body: {
            key: "STRIPE_SECRET_KEY",
            value: "sk_stripe",
            type: "sensitive",
            target: ["production"],
          },
        },
      ]);
      const build = calls.mock.calls.find(([, args]) => args.includes("build"));
      expect(build?.[2].env).not.toHaveProperty("OPENAI_API_KEY");
      expect(stdout + stderr).not.toMatch(/sk-openai|sk_stripe/);
    });

    it("stops before shipping when Vercel reports a failure, naming the key and never the value", async () => {
      const { fetch, calls, order } = vercelApi([{ error: { code: "x" } }]);
      const { code, stdout, stderr } = await deployStaging(fetch, calls);
      expect(code).toBe(1);
      expect(stderr).toContain(
        "cannot set OPENAI_API_KEY on the Vercel project of web in staging (HTTP 201)\n",
      );
      expect(order).not.toContain("vercel deploy --prebuilt");
      expect(stdout + stderr).not.toMatch(/sk-openai|sk_stripe/);
    });

    it("calls nothing in a dry run", async () => {
      const { fetch, calls } = vercelApi();
      const { code } = await deployStaging(fetch, calls, ["--dry-run"]);
      expect(code).toBe(0);
      expect(
        fetch.mock.calls.some(([input]) =>
          String(input).startsWith("https://api.vercel.com"),
        ),
      ).toBe(false);
    });
  });

  it("puts back the app's own vercel link file after building", async () => {
    const mine = '{"projectId":"prj_mine","orgId":"team_mine"}\n';
    const { code, cwd } = await run(
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
        "--dry-run",
      ],
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
          services: {
            web: {
              assets:
                "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz",
            },
          },
        }),
      ),
      "acme/builds/abc1230000000000000000000000000000000000/web.tar.gz":
        "archive",
    });
    const { code } = await run(
      ["promote", "--env", "production"],
      { "turbo-vibe.yaml": app },
      { ...vercelEnv, TURBO_VIBE_BUILDS_BUCKET: "tv-state" },
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
      [
        "deploy",
        "--env",
        "staging",
        "--build-id",
        "abc1230000000000000000000000000000000000",
        "--dry-run",
      ],
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
