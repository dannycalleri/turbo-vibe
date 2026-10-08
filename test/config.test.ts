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

  it("rejects an API hostname that another environment already uses", () => {
    const source = `${valid.replace("target: cloudflare-static\n    serve_with: api\n", "target: vercel-static\n")}environments:\n  staging: { api_hostname: api.acme.example.com }\n`;
    expect(problems(source)).toEqual([
      {
        line: 13,
        message:
          "the staging API and the production API both use hostname api.acme.example.com",
      },
    ]);
  });

  it("keeps the API hostname under the frontend's parent domain, so sign-in cookies can be shared", () => {
    const source = `${valid.replace("target: cloudflare-static\n    serve_with: api\n", "target: vercel-static\n")}environments:\n  production: { hostname: app.foo.co.uk, api_hostname: api.bar.co.uk }\n`;
    expect(problems(source)).toEqual([
      {
        line: 13,
        message:
          "the production API hostname api.bar.co.uk must be under foo.co.uk, like the frontend's app.foo.co.uk, so the two can share sign-in cookies",
      },
    ]);
  });

  it("needs a static frontend's output directory, but not a Next.js app's", () => {
    const frontend = (target: string) =>
      `version: 1\nproject: acme\ndomain: acme.example.com\nservices:\n  web:\n    kind: frontend\n    target: ${target}\n    build: { command: "npm ci" }\n`;
    expect(problems(frontend("vercel-static"))).toEqual([
      {
        line: 8,
        message:
          "missing required field `services.web.build.output` for target vercel-static",
      },
    ]);
    expect(parseConfig(frontend("vercel-nextjs")).ok).toBe(true);
  });

  it("rejects build settings a target would ignore", () => {
    const frontend = (target: string, build: string) =>
      `version: 1\nproject: acme\ndomain: acme.example.com\nservices:\n  web:\n    kind: frontend\n    target: ${target}\n    build:\n      command: npm ci\n${build}`;
    expect(
      problems(
        frontend("vercel-static", "      output: dist\n      root: web\n"),
      ),
    ).toEqual([
      {
        line: 11,
        message:
          "`services.web.build.root` applies only to targets that build their own output, not vercel-static",
      },
    ]);
    expect(problems(frontend("vercel-nextjs", "      output: out\n"))).toEqual([
      {
        line: 10,
        message:
          "`services.web.build.output` does not apply to vercel-nextjs, which builds its own output",
      },
    ]);
  });

  it("allows at most one identity service", () => {
    const identity = (name: string) =>
      `  ${name}:\n    kind: identity\n    target: workos\n`;
    expect(problems(valid + identity("auth") + identity("sso"))).toEqual([
      {
        line: 17,
        message:
          "service `sso` is a second identity; a project has at most one (`auth`)",
      },
    ]);
  });

  it("keeps the sign-in callback under /api/, where the backend answers", () => {
    expect(
      problems(
        `${valid}  auth:\n    kind: identity\n    target: workos\n    callback_path: /callback\n`,
      ),
    ).toEqual([
      {
        line: 17,
        message:
          "`services.auth.callback_path` must be a path under /api/, where the backend answers",
      },
    ]);
  });

  it("allows at most one database", () => {
    const db = (name: string) =>
      `  ${name}:\n    kind: database\n    target: supabase\n    organization: acme\n    region: eu-central-1\n`;
    expect(problems(valid + db("db") + db("analytics"))).toEqual([
      {
        line: 19,
        message:
          "service `analytics` is a second database; a project has at most one (`db`)",
      },
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

  it("refuses an instance rule it cannot route by, and extra instances nothing routes to", () => {
    const withContainer = (container: string) =>
      valid.replace(
        '    build: { dockerfile: Dockerfile, test: "make check" }\n',
        `    build: { dockerfile: Dockerfile, test: "make check" }\n    container: ${container}\n`,
      );
    expect(
      parseConfig(
        withContainer("{ instance_from: query:session, max_instances: 5 }"),
      ).ok,
    ).toBe(true);
    expect(
      problems(withContainer("{ instance_from: cookie:session }"))[0]?.message,
    ).toBe(
      "`services.api.container.instance_from` must be query:<parameter> or header:<name>",
    );
    expect(
      problems(withContainer("{ instance_from: query:session }"))[0]?.message,
    ).toBe(
      "service `api` routes requests by query:session, so it needs max_instances of 2 or more: sessions and the default instance share them",
    );
    expect(problems(withContainer("{ max_instances: 5 }"))[0]?.message).toBe(
      "service `api` allows 5 instances but sets no instance_from, so every request still goes to one instance",
    );
  });

  it("names the service, the target, and the available targets for an unknown target", () => {
    expect(
      problems(valid.replace("target: cloudflare-container", "target: heroku")),
    ).toEqual([
      {
        line: 7,
        message:
          "service `api` names unknown target `heroku`; available targets: cloudflare-container, cloudflare-static, supabase, workos, vercel-static, vercel-nextjs",
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
