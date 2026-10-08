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

const db = (extra = "") => `  db:
    kind: database
    target: supabase
    organization: acme-org
    region: eu-central-1
${extra}`;

describe("databases", () => {
  it("plans a Supabase project only when the config has a database", () => {
    expect(
      composeInfrastructure(config(api), "staging").supabase,
    ).toBeUndefined();
    expect(
      composeInfrastructure(config(api + db()), "production").supabase,
    ).toEqual({
      db: {
        organization_id: "acme-org",
        name: "acme-db-production",
        region: "eu-central-1",
        branch_of_production: false,
      },
    });
  });

  it("gives each environment its own project and exports its ref", () => {
    const root = rootModule(config(api + db()), "staging", {});
    expect(root.module.supabase_db).toMatchObject({ name: "acme-db-staging" });
    expect(root.module.supabase_db).not.toHaveProperty("parent_project_ref");
    expect(root.output).toEqual({
      supabase_db_project_ref: { value: "${module.supabase_db.project_ref}" },
      supabase_db_connection: {
        value: "${module.supabase_db.connection}",
        sensitive: true,
      },
    });
    expect(root.data).toBeUndefined();
  });

  it("runs staging as a branch of the production project read from production's state", () => {
    const branched = config(api + db("    plan: paid\n    staging: branch\n"));
    const staging = rootModule(branched, "staging", {
      TURBO_VIBE_STATE_BUCKET: "tv-state",
    });
    expect(staging.module.supabase_db?.parent_project_ref).toBe(
      "${data.terraform_remote_state.production.outputs.supabase_db_project_ref}",
    );
    expect(
      staging.data?.terraform_remote_state.production?.config,
    ).toMatchObject({
      bucket: "tv-state",
      key: "acme/production/terraform.tfstate",
    });
    expect(rootModule(branched, "production", {}).output).toHaveProperty(
      "supabase_db_project_ref",
    );
  });

  it("needs the Supabase token to apply", () => {
    expect(requiredSecrets(config(api + db()))).toContain(
      "SUPABASE_ACCESS_TOKEN",
    );
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
