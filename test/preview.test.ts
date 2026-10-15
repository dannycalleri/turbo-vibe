import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";
import { branchedDatabases, rootModule } from "../src/infrastructure.js";
import { layout } from "../src/origins.js";
import { previewEnvironment, previewFor, previewUrls } from "../src/preview.js";
import { capturing, fakeR2, run, runner, stateEnv } from "./harness.js";

const digest =
  "registry.cloudflare.com/acc123/shop-api@sha256:2222222222222222222222222222222222222222222222222222222222222222";

const staging = "staging-shop.example.com";

describe("previewEnvironment", () => {
  it("keeps a branch name that is already hostname-safe", () => {
    expect(previewEnvironment("feature-x", staging)).toBe("preview-feature-x");
  });

  it("turns other names into safe characters, with a hash so that nothing is lost", () => {
    expect(previewEnvironment("feature/Login_Page", staging)).toMatch(
      /^preview-feature-login-page-[0-9a-f]{6}$/,
    );
    expect(previewEnvironment("fix/café--ünïcode", staging)).toMatch(
      /^preview-fix-cafe-unicode-[0-9a-f]{6}$/,
    );
    expect(previewEnvironment("123-hotfix", staging)).toMatch(
      /^preview-pr-123-hotfix-[0-9a-f]{6}$/,
    );
  });

  it("never gives two branches the same preview, so closing one cannot remove the other", () => {
    const names = [
      "fix/login",
      "fix-login",
      "Fix_Login",
      "修正",
      "改善",
      "///",
    ].map((branch) => previewEnvironment(branch, staging));
    expect(new Set(names).size).toBe(names.length);
  });

  it("shortens a long branch so even the API's hostname label fits in 63 characters, keeping it unique", () => {
    const long = `feature/${"very-long-branch-name-".repeat(5)}`;
    const environment = previewEnvironment(long, staging);
    const label = `api-${environment.slice("preview-".length)}-staging-shop`;
    expect(label.length).toBeLessThanOrEqual(63);
    expect(environment).toMatch(/-[0-9a-f]{6}$/);
    expect(previewEnvironment(`${long}x`, staging)).not.toBe(environment);
  });

  it("keeps the API's whole hostname within the 64 characters a certificate allows", () => {
    const deep = "staging-vercel-example.turbovibe.ai";
    const environment = previewEnvironment(
      "supabase-organization-from-env",
      deep,
    );
    const hostname = `api-${environment.slice("preview-".length)}-${deep}`;
    expect(hostname.length).toBeLessThanOrEqual(64);
    expect(environment).toMatch(/^preview-supabase-[a-z0-9-]*[0-9a-f]{6}$/);
  });
});

function config(source: string): Config {
  const result = parseConfig(source);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.config;
}

const shop = `version: 1
project: shop
domain: shop.example.com
previews: true
environments:
  staging: { hostname: staging-shop.example.com }
services:
  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile }
`;

describe("preview hostnames", () => {
  it("put each preview one level below the zone, next to staging", () => {
    expect(layout(config(shop), "preview-feature-x").hostname).toBe(
      "feature-x-staging-shop.example.com",
    );
  });

  it("give a preview's API its own hostname when the frontend runs on Vercel", () => {
    const split = config(
      `${shop}  web:\n    kind: frontend\n    target: vercel-static\n    build: { command: x, output: dist }\n`,
    );
    expect(layout(split, "preview-feature-x")).toMatchObject({
      hostname: "feature-x-staging-shop.example.com",
      backendHostname: "api-feature-x-staging-shop.example.com",
    });
  });

  it("branch a preview's database from staging's project, in its own state", () => {
    const withDb = config(
      `${shop}  db:\n    kind: database\n    target: supabase\n    organization: acme\n    region: eu-central-1\n    plan: paid\n`,
    );
    expect(branchedDatabases(withDb, "preview-feature-x")).toEqual([
      {
        module: "supabase_db",
        parent: "staging",
        parentName: "shop-db-staging",
        organization: "acme",
      },
    ]);
    const root = rootModule(
      withDb,
      "preview-feature-x",
      { TURBO_VIBE_STATE_BUCKET: "tv-state" },
      {},
      { supabase_db: "stagingref" },
    );
    expect(root.terraform.backend.s3.key).toBe(
      "shop/preview-feature-x/terraform.tfstate",
    );
    expect(root.module.supabase_db?.parent_project_ref).toBe("stagingref");
    expect(JSON.stringify(root)).not.toContain("terraform_remote_state");
  });
});

describe("previewFor", () => {
  const crossOrigin = config(
    `${shop.replace(
      "staging: { hostname: staging-shop.example.com }",
      "staging: { hostname: staging-shop.example.com, api_hostname: api-staging-shop.example.com }",
    )}  web:\n    kind: frontend\n    target: vercel-static\n    build: { command: x, output: dist }\n`,
  );

  it("keeps an ordinary branch's name", () => {
    expect(previewFor("feature-x", crossOrigin)).toBe("preview-feature-x");
  });

  it("gives a branch named like a configured host a suffixed name, so it cannot take that host", () => {
    const hosts = layout(crossOrigin, "staging");
    expect(hosts.backendHostname).toBe("api-staging-shop.example.com");
    const environment = previewFor("api", crossOrigin);
    expect(environment).toMatch(/^preview-api-[0-9a-f]{6}$/);
    const preview = layout(crossOrigin, environment);
    expect([preview.hostname, preview.backendHostname]).not.toContain(
      hosts.backendHostname,
    );
  });

  it("never gives a pull request branch the live tests' preview", () => {
    expect(previewFor("live-3", crossOrigin)).not.toBe(
      previewFor("live run 3", crossOrigin),
    );
    expect(previewFor("live-run-3", crossOrigin)).not.toBe(
      previewFor("live run 3", crossOrigin),
    );
    for (const branch of ["live_run_3", "Live-Run-3", "live/run/3"])
      expect(previewFor(branch, crossOrigin)).toMatch(
        /^preview-pr-live-run-3-/,
      );
    const live = previewFor("live run 3", crossOrigin);
    expect(live).toMatch(/^preview-live-run-3-[0-9a-f]{6}$/);
    expect(previewFor(live.slice("preview-".length), crossOrigin)).not.toBe(
      live,
    );
  });
});

describe("previewUrls", () => {
  it("links a backend with no page on its hostname to /api/health, since its root reaches no origin", () => {
    expect(previewUrls(config(shop), "preview-feature-x")).toEqual([
      "https://feature-x-staging-shop.example.com/api/health",
    ]);
  });

  it("links the hostname once when the backend serves the page", () => {
    const served = config(
      `${shop}  web:\n    kind: frontend\n    target: cloudflare-static\n    serve_with: api\n    build: { command: x, output: dist }\n`,
    );
    expect(previewUrls(served, "preview-feature-x")).toEqual([
      "https://feature-x-staging-shop.example.com/",
    ]);
  });

  it("links a Vercel page at its root and its API at /api/health", () => {
    const split = config(
      `${shop}  web:\n    kind: frontend\n    target: vercel-static\n    build: { command: x, output: dist }\n`,
    );
    expect(previewUrls(split, "preview-feature-x")).toEqual([
      "https://api-feature-x-staging-shop.example.com/api/health",
      "https://feature-x-staging-shop.example.com/",
    ]);
  });
});

const env = { ...stateEnv, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ZONE_ID: "z" };

describe("turbo-vibe preview deploy", () => {
  it("applies, deploys and smoke-checks the preview, without recording it as promotable, then prints its URL", async () => {
    const r2 = fakeR2();
    const calls = runner();
    const fetch = r2.fetch((url) => Response.json({ build_id: "abc123", url }));
    const { code, cwd, stdout, stderr } = await run(
      ["preview", "deploy", "--branch", "feature-x", "--build-id", "abc123"],
      { "turbo-vibe.yaml": shop },
      env,
      calls,
      fetch,
      { capture: capturing({}, [digest]) },
    );
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(calls.mock.calls[0]).toEqual([
      "tofu",
      ["init", "-input=false", "-reconfigure"],
      expect.objectContaining({
        cwd: join(cwd, ".turbo-vibe", "tofu", "preview-feature-x"),
      }),
    ]);
    expect(stdout).toContain(
      "preview: https://feature-x-staging-shop.example.com/api/health\n",
    );
    expect([...r2.objects.keys()]).toEqual([]);
    const worker = JSON.parse(
      await readFile(
        join(
          cwd,
          ".turbo-vibe",
          "wrangler",
          "preview-feature-x",
          "shop-api-preview-feature-x",
          "wrangler.json",
        ),
        "utf8",
      ),
    );
    expect(worker.containers[0]).toMatchObject({ image: digest });
  });

  it("names a declared secret the preview environment lacks before applying anything", async () => {
    const calls = runner();
    const { code, stderr } = await run(
      ["preview", "deploy", "--branch", "feature-x", "--build-id", "abc123"],
      {
        "turbo-vibe.yaml": shop.replace(
          "    target: cloudflare-container\n",
          "    target: cloudflare-container\n    secrets: [STRIPE_SECRET_KEY]\n",
        ),
      },
      env,
      calls,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "preview-feature-x has no value for STRIPE_SECRET_KEY, declared in turbo-vibe.yaml; store it in the preview GitHub environment with `setup --env preview`\n",
    );
    expect(calls).not.toHaveBeenCalled();
  });

  it("skips a project whose database is on the free plan, and says why", async () => {
    const calls = runner();
    const { code, stdout } = await run(
      ["preview", "deploy", "--branch", "feature-x", "--build-id", "abc123"],
      {
        "turbo-vibe.yaml": `${shop}  db:\n    kind: database\n    target: supabase\n    organization: acme\n    region: eu-central-1\n`,
      },
      env,
      calls,
    );
    expect(code).toBe(0);
    expect(stdout).toBe(
      "no preview: database `db` is on the free Supabase plan, and a preview needs a database branch, which only paid plans have\n",
    );
    expect(calls).not.toHaveBeenCalled();
  });

  it("refuses a project that has not enabled previews", async () => {
    const { code, stderr } = await run(
      ["preview", "deploy", "--branch", "feature-x", "--build-id", "abc123"],
      { "turbo-vibe.yaml": shop.replace("previews: true\n", "") },
      env,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "previews are not enabled; set `previews: true` in turbo-vibe.yaml\n",
    );
  });
});

describe("turbo-vibe preview remove", () => {
  function containersApi(applications: { id: string; name: string }[]) {
    const deleted: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (init?.method === "DELETE") {
        deleted.push(url.split("/").at(-1) ?? "");
        return Response.json({ success: true });
      }
      return Response.json({ success: true, result: applications });
    });
    return { fetch, deleted };
  }

  it("deletes only the preview's container application, then destroys only the preview's state", async () => {
    const calls = runner();
    const { fetch, deleted } = containersApi([
      { id: "app-staging", name: "shop-api-staging-backend" },
      { id: "app-production", name: "shop-api-production-backend" },
      { id: "app-preview", name: "shop-api-preview-feature-x-backend" },
      { id: "app-other-preview", name: "shop-api-preview-feature-y-backend" },
    ]);
    const { code, cwd } = await run(
      ["preview", "remove", "--branch", "feature-x"],
      { "turbo-vibe.yaml": shop },
      env,
      calls,
      fetch,
    );
    expect(code).toBe(0);
    expect(deleted).toEqual(["app-preview"]);
    const previewRoot = join(cwd, ".turbo-vibe", "tofu", "preview-feature-x");
    expect(calls.mock.calls).toEqual([
      [
        "tofu",
        ["init", "-input=false", "-reconfigure"],
        expect.objectContaining({ cwd: previewRoot }),
      ],
      [
        "tofu",
        ["destroy", "-input=false", "-auto-approve"],
        expect.objectContaining({ cwd: previewRoot }),
      ],
    ]);
    const root = JSON.parse(
      await readFile(join(previewRoot, "main.tf.json"), "utf8"),
    );
    expect(root.terraform.backend.s3.key).toBe(
      "shop/preview-feature-x/terraform.tfstate",
    );
  });

  it("destroys a preview's database branch with its parent's ref, and still destroys when the parent is gone", async () => {
    const withDb = `${shop}  db:\n    kind: database\n    target: supabase\n    organization: acme\n    region: eu-central-1\n    plan: paid\n`;
    for (const [projects, expected] of [
      [
        [
          {
            id: "stagingref",
            name: "shop-db-staging",
            organization_id: "acme",
          },
        ],
        "stagingref",
      ],
      [[], undefined],
    ] as const) {
      const calls = runner();
      const { fetch: containers } = containersApi([]);
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
        String(input) === "https://api.supabase.com/v1/projects"
          ? Response.json(projects)
          : containers(input, init),
      );
      const { code, cwd } = await run(
        ["preview", "remove", "--branch", "feature-x"],
        { "turbo-vibe.yaml": withDb },
        { ...env, SUPABASE_ACCESS_TOKEN: "sbp_t0ken" },
        calls,
        fetch,
      );
      expect(code).toBe(0);
      expect(calls.mock.calls.at(-1)?.[1]).toEqual([
        "destroy",
        "-input=false",
        "-auto-approve",
      ]);
      const root = JSON.parse(
        await readFile(
          join(cwd, ".turbo-vibe", "tofu", "preview-feature-x", "main.tf.json"),
          "utf8",
        ),
      );
      expect(root.module.supabase_db.parent_project_ref).toBe(expected);
    }
  });

  it("names missing credentials before deleting anything", async () => {
    const calls = runner();
    const { fetch, deleted } = containersApi([
      { id: "app-preview", name: "shop-api-preview-feature-x-backend" },
    ]);
    const { CLOUDFLARE_ACCOUNT_ID: _, ...partial } = env;
    const { code, stderr } = await run(
      ["preview", "remove", "--branch", "feature-x"],
      { "turbo-vibe.yaml": shop },
      partial,
      calls,
      fetch,
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "missing environment variables: CLOUDFLARE_ACCOUNT_ID\n",
    );
    expect(deleted).toEqual([]);
    expect(calls).not.toHaveBeenCalled();
  });

  it("refuses to destroy anything that is not a preview", async () => {
    const { destroy } = await import("../src/apply.js");
    const stderr = vi.fn();
    const code = await destroy(config(shop), "staging", {
      cwd: "/tmp",
      env,
      stdout: vi.fn(),
      stderr,
      run: vi.fn(),
      capture: vi.fn(),
      fetch: vi.fn(),
      sleep: vi.fn(),
      sql: vi.fn(),
    });
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "refusing to destroy staging: only previews are ever removed\n",
    );
  });
});
