import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";
import { rootModule } from "../../src/infrastructure.js";

const repository = new URL("../../", import.meta.url).pathname;

function tofu(dir: string, args: string[]): string {
  try {
    execFileSync("tofu", ["version"], { stdio: "ignore" });
    return execFileSync("tofu", args, { cwd: dir, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${repository}:${repository}`,
        "-v",
        `${dir}:${dir}`,
        "-w",
        dir,
        "ghcr.io/opentofu/opentofu:1.13.1",
        ...args,
      ],
      { encoding: "utf8" },
    );
  }
}

describe("a preview's generated OpenTofu root", () => {
  it("validates with every adapter's module, its database branched from staging", async () => {
    const result = parseConfig(`version: 1
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
  web:
    kind: frontend
    target: vercel-static
    build: { command: x, output: dist }
  db:
    kind: database
    target: supabase
    organization: acme
    region: eu-central-1
    plan: paid
  auth:
    kind: identity
    target: workos
`);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-preview-root-"));
    const root = rootModule(
      result.config,
      "preview-feature-x",
      {
        TURBO_VIBE_STATE_BUCKET: "tv-state",
        CLOUDFLARE_ACCOUNT_ID: "acc123",
        CLOUDFLARE_ZONE_ID: "zone456",
        VERCEL_TEAM_ID: "team_1",
      },
      {},
      { supabase_db: "abcdefghijklmnopqrst" },
    );
    expect(root.module.supabase_db?.parent_project_ref).toBe(
      "abcdefghijklmnopqrst",
    );
    await writeFile(join(dir, "main.tf.json"), JSON.stringify(root));
    tofu(dir, ["init", "-backend=false", "-input=false"]);
    expect(tofu(dir, ["validate", "-no-color"])).toContain(
      "The configuration is valid.",
    );
  });
});
