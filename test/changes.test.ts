import { describe, expect, it } from "vitest";
import {
  classify,
  diagnostics,
  formatChanges,
  owners,
  summarize,
  type TofuPlan,
} from "../src/changes.js";
import { parseConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";

const configOf = (yaml: string): Config => {
  const result = parseConfig(yaml);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.config;
};

const config = configOf(`version: 1
project: acme
domain: acme.example.com
services:
  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile }
  site:
    kind: frontend
    target: vercel-static
    build: { command: "pnpm build", output: dist }
  db:
    kind: database
    target: supabase
    organization: acme-org
    region: eu-central-1
`);

const planOf = (
  ...changes: [string, string[], Record<string, unknown>?][]
): TofuPlan => ({
  resource_changes: changes.map(([address, actions, after]) => ({
    address,
    change: { actions, ...(after ? { after } : {}) },
  })),
});

describe("classify", () => {
  it.each([
    [["create"], "create"],
    [["update"], "update"],
    [["delete"], "delete"],
    [["delete", "create"], "replace"],
    [["create", "delete"], "replace"],
    [["no-op"], undefined],
    [["read"], undefined],
  ])("%j is %s", (actions, action) => {
    expect(classify(actions)).toBe(action);
  });
});

describe("summarize", () => {
  const owned = owners(config, "staging");

  it.each([
    [
      config,
      [
        ['module.cloudflare.cloudflare_worker.this["acme-api-staging"]', "api"],
        [
          'module.cloudflare.cloudflare_worker_version.placeholder["acme-api-staging"]',
          "api",
        ],
        [
          'module.cloudflare.cloudflare_workers_route.this["api.staging.acme.example.com/api/*"]',
          "api",
        ],
        [
          'module.cloudflare.cloudflare_dns_record.this["api.staging.acme.example.com"]',
          "api",
        ],
        [
          'module.cloudflare.cloudflare_dns_record.cname["staging.acme.example.com"]',
          "site",
        ],
        ['module.vercel.vercel_project.this["acme-site-staging"]', "site"],
        [
          'module.vercel.vercel_project_domain.this["acme-site-staging"]',
          "site",
        ],
        [
          'module.vercel.vercel_project_environment_variable.this["acme-site-staging/TURBO_VIBE_API_URL"]',
          "site",
        ],
        ["module.supabase_db.supabase_project.this[0]", "db"],
      ],
    ],
    [
      configOf(`version: 1
project: acme
domain: acme.example.com
services:
  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile }
  web:
    kind: frontend
    target: cloudflare-static
    serve_with: api
    build: { command: "pnpm build", output: dist }
  auth:
    kind: identity
    target: workos
`),
      [
        ['module.cloudflare.cloudflare_worker.this["acme-api-staging"]', "api"],
        [
          'module.cloudflare.cloudflare_workers_route.this["staging.acme.example.com/*"]',
          "api",
        ],
        [
          'module.workos_auth.workos_redirect_uri.this["https://staging.acme.example.com/api/auth/callback"]',
          "auth",
        ],
      ],
    ],
    [
      configOf(`version: 1
project: acme
domain: acme.example.com
services:
  web:
    kind: frontend
    target: cloudflare-static
    build: { command: "pnpm build", output: dist }
`),
      [
        ['module.cloudflare.cloudflare_worker.this["acme-web-staging"]', "web"],
        [
          'module.cloudflare.cloudflare_dns_record.this["staging.acme.example.com"]',
          "web",
        ],
      ],
    ],
    [
      configOf(`version: 1
project: acme
domain: acme.example.com
services:
  app:
    kind: frontend
    target: vercel-nextjs
    build: { command: "next build" }
`),
      [
        ['module.vercel.vercel_project.this["acme-app-staging"]', "app"],
        [
          'module.cloudflare.cloudflare_dns_record.cname["staging.acme.example.com"]',
          "app",
        ],
      ],
    ],
  ])(
    "attributes each adapter's resources to its service (%#)",
    (project, expected) => {
      const changes = summarize(
        planOf(
          ...expected.map(
            ([address]) => [address, ["create"]] as [string, string[]],
          ),
        ),
        owners(project, "staging"),
      );
      expect(
        changes.map(({ address, owners }) => [address, owners.join(", ")]),
      ).toEqual(expected);
    },
  );

  it("leaves a resource no service produces without an owner, and skips no-ops and reads", () => {
    const changes = summarize(
      {
        resource_changes: [
          {
            address:
              'module.cloudflare.cloudflare_worker.this["acme-old-staging"]',
            change: { actions: ["delete"] },
          },
          {
            address: "module.supabase_db.supabase_settings.this",
            change: { actions: ["no-op"] },
          },
          {
            address: "data.terraform_remote_state.production",
            mode: "data",
            change: { actions: ["read"] },
          },
        ],
      },
      owned,
    );
    expect(changes).toEqual([
      {
        address: 'module.cloudflare.cloudflare_worker.this["acme-old-staging"]',
        action: "delete",
        owners: [],
      },
    ]);
  });
});

describe("diagnostics", () => {
  it("reports OpenTofu's warnings and errors from its JSON output, skipping other messages", () => {
    const output = [
      JSON.stringify({ type: "version", "@level": "info" }),
      JSON.stringify({
        type: "diagnostic",
        "@level": "warn",
        diagnostic: { summary: "Deprecated attribute" },
      }),
      JSON.stringify({
        type: "diagnostic",
        "@level": "error",
        diagnostic: { summary: "Invalid token", detail: "line one\nline two" },
      }),
    ].join("\n");
    expect(diagnostics(output)).toEqual([
      "warning: Deprecated attribute",
      "error: Invalid token\n  line one\n  line two",
    ]);
  });
});

describe("formatChanges", () => {
  it("reports an environment with nothing to do", () => {
    expect(formatChanges("staging", [])).toBe("staging: no changes");
  });

  it("groups changes by service and calls out deletions and replacements apart", () => {
    const text = formatChanges("staging", [
      { address: "a", action: "create", owners: ["api"] },
      { address: "b", action: "update", owners: ["site"] },
      { address: "c", action: "replace", owners: ["db"] },
      { address: "d", action: "delete", owners: [] },
    ]);
    expect(text).toBe(
      [
        "staging: 1 to create, 1 to change, 1 to replace, 1 to delete",
        "",
        "api",
        "  + a",
        "",
        "site",
        "  ~ b",
        "",
        "Deletions and replacements:",
        "  -/+ c (db)",
        "  - d (staging, no service)",
      ].join("\n"),
    );
  });

  it("never prints an attribute value", () => {
    const text = formatChanges(
      "staging",
      summarize(
        planOf([
          'module.vercel.vercel_project_environment_variable.this["acme-site-staging/TURBO_VIBE_API_URL"]',
          ["update"],
          { value: "s3cr3t-value" },
        ]),
        owners(config, "staging"),
      ),
    );
    expect(text).toContain("TURBO_VIBE_API_URL");
    expect(text).not.toContain("s3cr3t");
  });
});
