import { describe, expect, it } from "vitest";
import { adapterFor } from "../src/adapters/index.js";
import { parseConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";
import {
  composeInfrastructure,
  requiredSecrets,
  rootModule,
  stateKey,
} from "../src/infrastructure.js";

function config(services: string): Config {
  const result = parseConfig(
    `version: 1\nproject: acme\ndomain: acme.example.com\nservices:\n${services}`,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.config;
}

const api = `  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile }
`;
const web = (extra = "") => `  web:
    kind: frontend
    target: cloudflare-static
${extra}    build: { command: "pnpm build", output: dist }
`;

describe("adapterFor", () => {
  it("selects the adapter for each target", () => {
    expect(adapterFor("cloudflare-container").kind).toBe("backend");
    expect(adapterFor("cloudflare-static").kind).toBe("frontend");
  });

  it("throws for a target with no adapter", () => {
    expect(() => adapterFor("heroku")).toThrow(
      "no adapter for target `heroku`",
    );
  });
});

describe("composeInfrastructure", () => {
  it("routes /api/ to a backend that serves no frontend", () => {
    expect(composeInfrastructure(config(api), "staging")).toEqual({
      cloudflare: {
        workers: {
          "acme-api-staging": { routes: ["staging.acme.example.com/api/*"] },
        },
        hostnames: ["staging.acme.example.com"],
      },
    });
  });

  it("places a serve_with frontend in the backend's Worker, which takes the whole hostname", () => {
    expect(
      composeInfrastructure(
        config(api + web("    serve_with: api\n")),
        "production",
      ),
    ).toEqual({
      cloudflare: {
        workers: { "acme-api-production": { routes: ["acme.example.com/*"] } },
        hostnames: ["acme.example.com"],
      },
    });
  });

  it("gives a standalone frontend its own Worker on the same hostname", () => {
    expect(composeInfrastructure(config(api + web()), "staging")).toEqual({
      cloudflare: {
        workers: {
          "acme-api-staging": { routes: ["staging.acme.example.com/api/*"] },
          "acme-web-staging": { routes: ["staging.acme.example.com/*"] },
        },
        hostnames: ["staging.acme.example.com"],
      },
    });
  });
});

describe("state", () => {
  it("keeps one state per project and environment", () => {
    expect(stateKey("acme", "staging")).toBe("acme/staging/terraform.tfstate");
    expect(stateKey("acme", "production")).toBe(
      "acme/production/terraform.tfstate",
    );
  });

  it("locks state in the R2 bucket with a lock file", () => {
    const root = rootModule(config(api), "staging", {
      TURBO_VIBE_STATE_BUCKET: "tv-state",
      CLOUDFLARE_ACCOUNT_ID: "acc123",
      CLOUDFLARE_ZONE_ID: "zone456",
    });
    expect(root.terraform.backend.s3).toMatchObject({
      bucket: "tv-state",
      key: "acme/staging/terraform.tfstate",
      endpoints: { s3: "https://acc123.r2.cloudflarestorage.com" },
      use_lockfile: true,
    });
    expect(root.module.cloudflare).toMatchObject({
      account_id: "acc123",
      zone_id: "zone456",
    });
  });

  it("requires the state and Cloudflare credentials a Cloudflare project uses", () => {
    expect(requiredSecrets(config(api))).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ZONE_ID",
      "TURBO_VIBE_STATE_BUCKET",
    ]);
  });
});
