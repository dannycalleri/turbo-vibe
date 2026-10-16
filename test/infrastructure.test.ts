import { describe, expect, it } from "vitest";
import { adapterFor } from "../src/adapters/index.js";
import { parseConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";
import {
  branchedDatabases,
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
      },
    });
  });

  it("gives each environment its own project", () => {
    const root = rootModule(config(api + db()), "staging", {});
    expect(root.module.supabase_db).toMatchObject({ name: "acme-db-staging" });
    expect(root.module.supabase_db).not.toHaveProperty("parent_project_ref");
    expect(root.output).toEqual({
      supabase_db_connection: {
        value: "${module.supabase_db.connection}",
        sensitive: true,
      },
    });
  });

  it("runs staging as a branch of the production project, given only its ref", () => {
    const branched = config(api + db("    plan: paid\n    staging: branch\n"));
    expect(branchedDatabases(branched, "staging")).toEqual([
      {
        module: "supabase_db",
        parent: "production",
        parentName: "acme-db-production",
        organization: "acme-org",
      },
    ]);
    const staging = rootModule(
      branched,
      "staging",
      {},
      {},
      {
        supabase_db: "prodref123",
      },
    );
    expect(staging.module.supabase_db?.parent_project_ref).toBe("prodref123");
    expect(JSON.stringify(staging)).not.toContain("terraform_remote_state");
    expect(branchedDatabases(branched, "production")).toEqual([]);
  });

  it("needs the Supabase token to apply", () => {
    expect(requiredSecrets(config(api + db()))).toContain(
      "SUPABASE_ACCESS_TOKEN",
    );
  });

  it("takes the organization from SUPABASE_ORGANIZATION when the file leaves it out", () => {
    const withoutOrganization = config(
      api + db().replace("    organization: acme-org\n", ""),
    );
    expect(requiredSecrets(withoutOrganization)).toContain(
      "SUPABASE_ORGANIZATION",
    );
    expect(requiredSecrets(config(api + db()))).not.toContain(
      "SUPABASE_ORGANIZATION",
    );
    const env = { SUPABASE_ORGANIZATION: "from-env" };
    expect(
      rootModule(withoutOrganization, "staging", env).module.supabase_db,
    ).toMatchObject({ organization_id: "from-env" });
    expect(
      rootModule(config(api + db()), "staging", env).module.supabase_db,
    ).toMatchObject({ organization_id: "acme-org" });
  });
});

describe("identity", () => {
  const auth = "  auth:\n    kind: identity\n    target: workos\n";

  it("registers the environment's callback through the workos module", () => {
    const root = rootModule(config(api + auth), "staging", {});
    expect(root.module.workos_auth).toEqual({
      source: expect.stringMatching(/infra\/workos$/),
      redirect_uris: ["https://staging.acme.example.com/api/auth/callback"],
    });
    expect(root.output?.workos_auth_redirect_uris).toEqual({
      value: "${module.workos_auth.redirect_uris}",
    });
  });

  it("hands OpenTofu only the URIs discovery says the kit manages", () => {
    expect(
      rootModule(config(api + auth), "staging", {}, { auth: [] }).module
        .workos_auth,
    ).toMatchObject({
      redirect_uris: [],
    });
  });

  it("needs the environment's WorkOS key and client ID to apply", () => {
    expect(requiredSecrets(config(api + auth))).toEqual(
      expect.arrayContaining(["WORKOS_API_KEY", "WORKOS_CLIENT_ID"]),
    );
  });
});

describe("vercel-static", () => {
  const site = config(
    `  web:\n    kind: frontend\n    target: vercel-static\n    build: { command: "pnpm build", output: dist }\n`,
  );

  it("gives each environment its own Vercel project on the environment's hostname, pointed at Vercel by a DNS-only CNAME", () => {
    const root = rootModule(site, "staging", {
      VERCEL_TEAM_ID: "team_123",
      CLOUDFLARE_ZONE_ID: "zone456",
    });
    expect(root.module.vercel).toEqual({
      source: expect.stringMatching(/infra\/vercel$/),
      team_id: "team_123",
      projects: {
        "acme-web-staging": {
          domain: "staging.acme.example.com",
          environment: {},
        },
      },
    });
    expect(root.module.cloudflare).toMatchObject({
      workers: {},
      hostnames: [],
      cnames: { "staging.acme.example.com": "cname.vercel-dns.com" },
    });
    expect(root.output?.vercel_project_ids).toEqual({
      value: "${module.vercel.project_ids}",
    });
    expect(rootModule(site, "production", {}).module.vercel).toMatchObject({
      projects: { "acme-web-production": { domain: "acme.example.com" } },
    });
  });

  it("needs the Vercel token and team, and the Cloudflare zone for DNS, to apply", () => {
    expect(requiredSecrets(site)).toEqual(
      expect.arrayContaining([
        "VERCEL_API_TOKEN",
        "VERCEL_TEAM_ID",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_ZONE_ID",
      ]),
    );
  });
});

describe("a Vercel frontend with a Cloudflare backend", () => {
  const split = config(
    `${api}  web:\n    kind: frontend\n    target: vercel-static\n    build: { command: "pnpm build", output: dist }\n`,
  );

  it("serves the backend from its API hostname and the frontend from the environment's hostname", () => {
    expect(rootModule(split, "staging", {}).module.cloudflare).toMatchObject({
      workers: {
        "acme-api-staging": { routes: ["api.staging.acme.example.com/api/*"] },
      },
      hostnames: ["api.staging.acme.example.com"],
      cnames: { "staging.acme.example.com": "cname.vercel-dns.com" },
    });
  });

  it("gives each environment's Vercel project that environment's backend URL", () => {
    expect(rootModule(split, "staging", {}).module.vercel).toMatchObject({
      projects: {
        "acme-web-staging": {
          environment: {
            TURBO_VIBE_API_URL: "https://api.staging.acme.example.com",
          },
        },
      },
    });
    expect(rootModule(split, "production", {}).module.vercel).toMatchObject({
      projects: {
        "acme-web-production": {
          environment: { TURBO_VIBE_API_URL: "https://api.acme.example.com" },
        },
      },
    });
  });

  it("registers the sign-in callback on the backend's hostname", () => {
    const withAuth = config(
      `${api}  web:\n    kind: frontend\n    target: vercel-static\n    build: { command: "pnpm build", output: dist }\n  auth:\n    kind: identity\n    target: workos\n`,
    );
    expect(
      rootModule(withAuth, "staging", {}).module.workos_auth,
    ).toMatchObject({
      redirect_uris: ["https://api.staging.acme.example.com/api/auth/callback"],
    });
  });
});

describe("production", () => {
  it("gets its own resources from every adapter", () => {
    const auth = "  auth:\n    kind: identity\n    target: workos\n";
    const root = rootModule(config(api + db() + auth), "production", {});
    expect(root.terraform.backend.s3.key).toBe(
      "acme/production/terraform.tfstate",
    );
    expect(root.module.cloudflare).toMatchObject({
      workers: {
        "acme-api-production": { routes: ["acme.example.com/api/*"] },
      },
      hostnames: ["acme.example.com"],
    });
    expect(root.module.supabase_db).toMatchObject({
      name: "acme-db-production",
    });
    expect(root.module.workos_auth).toMatchObject({
      redirect_uris: ["https://acme.example.com/api/auth/callback"],
    });
  });
});

describe("always_use_https", () => {
  it("redirects HTTP to HTTPS on the zone from staging and production, never from a preview", () => {
    for (const environment of ["staging", "production"] as const) {
      expect(
        rootModule(config(web()), environment, {}).module.cloudflare,
      ).toMatchObject({ always_use_https: true });
    }
    expect(
      rootModule(config(web()), "preview-feature-x", {}).module.cloudflare,
    ).not.toHaveProperty("always_use_https");
  });

  it("leaves the zone alone when Cloudflare serves no hostname", () => {
    const site = config(
      "  web:\n    kind: frontend\n    target: vercel-static\n    build: { command: x, output: dist }\n",
    );
    expect(
      rootModule(site, "production", {}).module.cloudflare,
    ).not.toHaveProperty("always_use_https");
  });
});

describe("access", () => {
  const privateStaging = (() => {
    const result = parseConfig(
      `version: 1\nproject: acme\ndomain: acme.example.com\nenvironments:\n  staging:\n    access: { emails: [ada@example.com] }\nservices:\n${web()}`,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.config;
  })();

  it("puts a private environment's hostnames behind Access and outputs the smoke test's service token", () => {
    const root = rootModule(privateStaging, "staging", {});
    expect(root.module.cloudflare?.access).toEqual({
      name: "acme-staging",
      domains: ["staging.acme.example.com"],
      emails: ["ada@example.com"],
    });
    expect(root.output?.access_client_secret).toEqual({
      value: `\${module.cloudflare.access_client_secret}`,
      sensitive: true,
    });
  });

  it("guards a preview like staging, under its own name", () => {
    expect(
      rootModule(privateStaging, "preview-feature-x", {}).module.cloudflare
        ?.access,
    ).toMatchObject({
      name: "acme-preview-feature-x",
      domains: ["feature-x-staging.acme.example.com"],
    });
  });

  it("leaves an environment without access public", () => {
    const root = rootModule(privateStaging, "production", {});
    expect(root.module.cloudflare).not.toHaveProperty("access");
    expect(root.output).toBeUndefined();
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
