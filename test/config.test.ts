import { describe, expect, it } from "vitest";
import type { TargetCatalog } from "../src/adapters/index.js";
import { parseConfig } from "../src/config/load.js";

const valid = `version: 1
project: acme
domain: acme.example.com
services:
  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile, test: "make check" }
  web:
    kind: frontend
    target: cloudflare-static
    serve_with: api
    build: { command: "pnpm build", output: web/dist }
`;

function problems(source: string, catalog?: TargetCatalog) {
  const result = parseConfig(source, catalog);
  if (result.ok) throw new Error("expected the config to be rejected");
  return result.problems;
}

describe("parseConfig", () => {
  it("accepts a backend with a frontend served from its Worker", () => {
    const result = parseConfig(valid);
    expect(result.ok).toBe(true);
  });

  it("reports an unknown top-level key with its line", () => {
    expect(problems(valid.replace("domain:", "domian:"))).toContainEqual({
      line: 3,
      message: "unknown key `domian`",
    });
  });

  it("reports an unknown nested key with its line", () => {
    const source = valid.replace(
      "    kind: frontend",
      "    kind: frontend\n    colour: blue",
    );
    expect(problems(source)).toEqual([
      { line: 11, message: "unknown key `services.web.colour`" },
    ]);
  });

  it("reports a missing field at the line of the mapping that lacks it", () => {
    const source = valid.replace(
      '    build: { dockerfile: Dockerfile, test: "make check" }\n',
      "",
    );
    expect(problems(source)).toEqual([
      { line: 5, message: "missing required field `services.api.build`" },
    ]);
  });

  it("reports a missing top-level field", () => {
    expect(problems(valid.replace("project: acme\n", ""))).toEqual([
      { line: 1, message: "missing required field `project`" },
    ]);
  });

  it("rejects an invalid service name", () => {
    expect(
      problems(
        valid
          .replace("  api:", "  API:")
          .replace("serve_with: api", "serve_with: API"),
      ),
    ).toContainEqual(expect.objectContaining({ line: 5 }));
  });

  it("reports a missing version as missing", () => {
    expect(problems(valid.replace("version: 1\n", ""))).toEqual([
      { line: 1, message: "missing required field `version`" },
    ]);
  });

  it("rejects two backends that would share /api/", () => {
    const source = `${valid}  worker:\n    kind: backend\n    target: cloudflare-container\n    build: { dockerfile: worker/Dockerfile }\n`;
    expect(problems(source)).toEqual([
      {
        line: 14,
        message: "services `api` and `worker` would both be served at /api/",
      },
    ]);
  });

  it("rejects two frontends that would share the hostname root", () => {
    const source = `${valid}  docs:\n    kind: frontend\n    target: cloudflare-static\n    build: { command: "pnpm docs", output: docs/dist }\n`;
    expect(problems(source)).toEqual([
      {
        line: 14,
        message: "services `web` and `docs` would both be served at /",
      },
    ]);
  });

  it("rejects staging and production on the same hostname", () => {
    const source = `${valid}environments:\n  staging: { hostname: acme.example.com }\n`;
    expect(problems(source)).toEqual([
      {
        line: 14,
        message: "staging and production both use hostname acme.example.com",
      },
    ]);
  });

  it("accepts container settings and rejects an invalid idle time", () => {
    const withContainer = valid.replace(
      '    build: { dockerfile: Dockerfile, test: "make check" }\n',
      '    build: { dockerfile: Dockerfile, test: "make check" }\n    container: { instance_type: basic, sleep_after: 10m }\n',
    );
    expect(parseConfig(withContainer).ok).toBe(true);
    expect(
      problems(withContainer.replace("sleep_after: 10m", "sleep_after: soon")),
    ).toEqual([
      {
        line: 9,
        message:
          "`services.api.container.sleep_after` must be a duration such as 30s, 5m, or 1h",
      },
    ]);
  });

  it("requires a database's Supabase organization and region", () => {
    const source = `${valid}  db:\n    kind: database\n    target: supabase\n`;
    expect(problems(source)).toEqual([
      {
        line: 14,
        message: "missing required field `services.db.organization`",
      },
      { line: 14, message: "missing required field `services.db.region`" },
    ]);
  });

  it("rejects staging as a branch on a free Supabase plan", () => {
    const db = `  db:\n    kind: database\n    target: supabase\n    organization: acme\n    region: eu-central-1\n    staging: branch\n`;
    expect(problems(valid + db)).toEqual([
      {
        line: 19,
        message:
          "service `db` sets staging: branch, which needs a paid Supabase plan (plan: paid)",
      },
    ]);
    expect(parseConfig(`${valid + db}    plan: paid\n`).ok).toBe(true);
  });

  it("names the service, the target, and the available targets for an unknown target", () => {
    expect(
      problems(valid.replace("target: cloudflare-container", "target: heroku")),
    ).toEqual([
      {
        line: 7,
        message:
          "service `api` names unknown target `heroku`; available targets: cloudflare-container, cloudflare-static, supabase",
      },
    ]);
  });

  it("rejects a target that runs a different kind of service", () => {
    expect(
      problems(
        valid.replace(
          "target: cloudflare-static",
          "target: cloudflare-container",
        ),
      ),
    ).toEqual([
      {
        line: 11,
        message:
          "service `web` is a frontend but target `cloudflare-container` runs backend services",
      },
    ]);
  });

  it("rejects serve_with on a backend whose target cannot serve static assets", () => {
    const catalog: TargetCatalog = {
      "plain-container": { kind: "backend", hostsStaticAssets: false },
      "cloudflare-static": { kind: "frontend", hostsStaticAssets: true },
    };
    const source = valid.replace(
      "target: cloudflare-container",
      "target: plain-container",
    );
    expect(problems(source, catalog)).toEqual([
      {
        line: 12,
        message:
          "service `web` (cloudflare-static) cannot be served with `api` (plain-container)",
      },
    ]);
  });

  it("rejects serve_with naming a service that is not a backend", () => {
    expect(
      problems(valid.replace("serve_with: api", "serve_with: web")),
    ).toEqual([
      {
        line: 12,
        message:
          "service `web` sets serve_with to `web`, which is not a backend service",
      },
    ]);
  });

  it("reports YAML syntax errors with their line and no position suffix", () => {
    expect(problems(`${valid}  web:\n    kind: frontend\n`)).toEqual([
      { line: 14, message: "Map keys must be unique" },
    ]);
  });

  it("rejects a file that is not a mapping", () => {
    expect(problems("- just\n- a list\n")).toEqual([
      { line: 1, message: "the file must be a YAML mapping" },
    ]);
  });
});
