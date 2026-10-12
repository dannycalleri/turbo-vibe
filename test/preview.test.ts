import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";
import { rootModule } from "../src/infrastructure.js";
import { layout } from "../src/origins.js";
import { previewEnvironment } from "../src/preview.js";
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
    const root = rootModule(withDb, "preview-feature-x", {
      TURBO_VIBE_STATE_BUCKET: "tv-state",
    });
    expect(root.terraform.backend.s3.key).toBe(
      "shop/preview-feature-x/terraform.tfstate",
    );
    expect(root.data?.terraform_remote_state.staging?.config.key).toBe(
      "shop/staging/terraform.tfstate",
    );
    expect(root.module.supabase_db?.parent_project_ref).toBe(
      "${data.terraform_remote_state.staging.outputs.supabase_db_project_ref}",
    );
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
      "preview: https://feature-x-staging-shop.example.com/\n",
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
