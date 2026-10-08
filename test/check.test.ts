import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { checksFor, formatFindings, runChecks } from "../src/check.js";
import { cloudflare, requiredPermissions } from "../src/checks/cloudflare.js";
import { localTools } from "../src/checks/local.js";
import { stateBucket } from "../src/checks/state.js";
import type { CheckContext, Finding } from "../src/checks/types.js";
import { fail, ok, warn } from "../src/checks/types.js";
import { parseConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";
import type { Io } from "../src/io.js";

function config(services: string): Config {
  const result = parseConfig(
    `version: 1\nproject: acme\ndomain: app.turbovibe.ai\nservices:\n${services}`,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.config;
}
const container =
  "  api:\n    kind: backend\n    target: cloudflare-container\n    build: { dockerfile: Dockerfile }\n";
const vercel =
  "  web:\n    kind: frontend\n    target: vercel-static\n    build: { command: x, output: dist }\n";
const db =
  "  db:\n    kind: database\n    target: supabase\n    organization: acme\n    region: eu-central-1\n";

function context(
  services: string,
  env: Record<string, string> = {},
  extra: Partial<Io> = {},
): CheckContext {
  return {
    config: config(services),
    environment: "staging",
    nodeVersion: "24.12.0",
    io: {
      cwd: "/repo",
      env,
      stdout: () => {},
      stderr: () => {},
      run: vi.fn(),
      capture: vi.fn(async () => ({
        code: 0,
        stdout: JSON.stringify({ terraform_version: "1.13.1" }),
      })),
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      sleep: async () => {},
      sql: vi.fn(),
      ...extra,
    },
  };
}

describe("runChecks and formatFindings", () => {
  it("collects every check's findings, and turns a crashing check into a failure instead of stopping", async () => {
    const findings = await runChecks(
      [
        async () => [ok("node", "Node 24")],
        async function broken() {
          throw new Error("socket hang up");
        },
        async () => [
          warn("vercel", "Hobby plan", "commercial projects need Pro"),
        ],
      ],
      context(container),
    );
    expect(
      findings.map((finding) => [finding.check, finding.severity]),
    ).toEqual([
      ["node", "ok"],
      ["broken", "fail"],
      ["vercel", "warn"],
    ]);
    expect(findings[1]?.message).toBe("could not finish: socket hang up");
  });

  it("prints each problem with its fix and counts the problems", () => {
    const findings: Finding[] = [
      ok("node", "Node 24"),
      fail(
        "cloudflare",
        "CLOUDFLARE_API_TOKEN lacks DNS Write on turbovibe.ai",
        "add DNS Write for zone turbovibe.ai",
      ),
      warn("vercel", "team is on Hobby", "commercial projects need Pro"),
    ];
    expect(formatFindings("staging", findings)).toBe(
      [
        "staging",
        "  ok    node: Node 24",
        "  FAIL  cloudflare: CLOUDFLARE_API_TOKEN lacks DNS Write on turbovibe.ai",
        "        fix: add DNS Write for zone turbovibe.ai",
        "  warn  vercel: team is on Hobby",
        "        fix: commercial projects need Pro",
        "staging has 1 problem",
        "",
      ].join("\n"),
    );
  });

  it("reports an environment with no failures as ready", () => {
    expect(
      formatFindings("production", [ok("node", "Node 24"), warn("x", "y")]),
    ).toMatch(/production is ready\n$/);
  });
});

describe("checks are limited to what the project uses", () => {
  it("checks Cloudflare only when a target uses it", () => {
    expect(checksFor(config(db)).map((check) => check.name)).toEqual([
      "localTools",
      "stateBucket",
    ]);
    expect(checksFor(config(container)).map((check) => check.name)).toContain(
      "cloudflare",
    );
    expect(checksFor(config(vercel)).map((check) => check.name)).toContain(
      "cloudflare",
    );
  });

  it("asks a Vercel-only project's token for DNS alone, and a container project's for Workers and Containers too", () => {
    expect(requiredPermissions(context(vercel))).toEqual(["DNS Write"]);
    expect(requiredPermissions(context(container))).toEqual([
      "DNS Write",
      "Workers Scripts Write",
      "Workers Routes Write",
      "Containers Write",
    ]);
  });
});

describe("check", () => {
  const io = context(container).io;
  it("exits non-zero when any check fails", async () => {
    const { check } = await import("../src/check.js");
    const code = await check(config(container), "staging", io, "24.12.0", [
      async () => [
        ok("node", "Node 24"),
        fail("cloudflare", "token lacks DNS Write", "add it"),
      ],
    ]);
    expect(code).toBe(1);
  });

  it("exits zero when nothing fails, warnings included", async () => {
    const { check } = await import("../src/check.js");
    const code = await check(config(container), "staging", io, "24.12.0", [
      async () => [ok("node", "Node 24"), warn("vercel", "Hobby plan")],
    ]);
    expect(code).toBe(0);
  });
});

describe("stateBucket without its variables", () => {
  it("reports the missing variables once, as one problem", async () => {
    const findings = await stateBucket(
      context(db, { CLOUDFLARE_ACCOUNT_ID: "acc123" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toBe(
      "TURBO_VIBE_STATE_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY are not set",
    );
  });
});

describe("localTools", () => {
  it("passes Node 24 and OpenTofu 1.10 or later", async () => {
    expect(
      (await localTools(context(container))).map((finding) => finding.severity),
    ).toEqual(["ok", "ok"]);
  });

  it("names an old Node and a missing or old tofu with how to fix them", async () => {
    const old = { ...context(container), nodeVersion: "22.4.0" };
    const [node] = await localTools(old);
    expect(node).toMatchObject({
      severity: "fail",
      message: "Node 22.4.0 is older than 24",
    });

    const missingTofu = context(
      container,
      {},
      { capture: vi.fn(async () => Promise.reject(new Error("ENOENT"))) },
    );
    expect((await localTools(missingTofu))[1]).toMatchObject({
      severity: "fail",
      message: "OpenTofu (`tofu`) is not on PATH",
    });

    const oldTofu = context(
      container,
      {},
      {
        capture: vi.fn(async () => ({
          code: 0,
          stdout: JSON.stringify({ terraform_version: "1.9.1" }),
        })),
      },
    );
    expect((await localTools(oldTofu))[1]?.message).toBe(
      "OpenTofu 1.9.1 is older than 1.10, which state locking on R2 needs",
    );
  });
});

describe("against recorded fakes", () => {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  const cloudflareEnv = {
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "acc123",
    CLOUDFLARE_ZONE_ID: "zone456",
  };
  const envelope = (result: unknown) =>
    HttpResponse.json({ success: true, errors: [], result });
  type Grant = { name: string; zone?: string; effect?: "allow" | "deny" };
  const zoneScoped = new Set(["DNS Write", "Workers Routes Write"]);
  function policy({ name, zone = "zone456", effect = "allow" }: Grant) {
    return {
      effect,
      permission_groups: [{ name }],
      resources: zoneScoped.has(name)
        ? { [`com.cloudflare.api.account.zone.${zone}`]: "*" }
        : { "com.cloudflare.api.account.acc123": "*" },
    };
  }
  function cloudflareApi({
    permissions,
    zoneStatus = "active",
    plan = "workers_paid",
  }: {
    permissions: (string | Grant)[];
    zoneStatus?: string;
    plan?: string;
  }) {
    server.use(
      http.get("https://api.cloudflare.com/client/v4/user/tokens/verify", () =>
        envelope({ id: "tok1", status: "active" }),
      ),
      http.get("https://api.cloudflare.com/client/v4/user/tokens/tok1", () =>
        envelope({
          policies: permissions.map((grant) =>
            policy(typeof grant === "string" ? { name: grant } : grant),
          ),
        }),
      ),
      http.get("https://api.cloudflare.com/client/v4/zones/zone456", () =>
        envelope({
          name: "turbovibe.ai",
          status: zoneStatus,
          name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
        }),
      ),
      http.get(
        "https://api.cloudflare.com/client/v4/accounts/acc123/subscriptions",
        () =>
          envelope([
            {
              rate_plan: {
                id: plan,
                public_name: plan === "workers_paid" ? "Workers Paid" : "Free",
              },
            },
          ]),
      ),
    );
  }

  it("does not count DNS Write granted on another zone, or one a deny policy takes away", async () => {
    for (const dns of [
      { name: "DNS Write", zone: "other-zone" },
      [{ name: "DNS Write" }, { name: "DNS Write", effect: "deny" as const }],
    ]) {
      cloudflareApi({
        permissions: [
          ...[dns].flat(),
          "Workers Scripts Write",
          "Workers Routes Write",
          "Containers Write",
        ],
      });
      const failures = (
        await cloudflare(context(container, cloudflareEnv))
      ).filter((finding) => finding.severity === "fail");
      expect(failures.map((finding) => finding.message)).toEqual([
        "CLOUDFLARE_API_TOKEN lacks DNS Write on turbovibe.ai",
      ]);
    }
  });

  it("names the token, the missing DNS permission, and the domain", async () => {
    cloudflareApi({
      permissions: [
        "Workers Scripts Write",
        "Workers Routes Write",
        "Containers Write",
      ],
    });
    const findings = await cloudflare(context(container, cloudflareEnv));
    expect(findings.filter((finding) => finding.severity === "fail")).toEqual([
      {
        check: "cloudflare",
        severity: "fail",
        message: "CLOUDFLARE_API_TOKEN lacks DNS Write on turbovibe.ai",
        fix: "edit the token in Cloudflare → My Profile → API Tokens and add DNS Write for zone turbovibe.ai",
      },
    ]);
  });

  it("is satisfied when the token, zone, and plan are in place", async () => {
    cloudflareApi({
      permissions: [
        "DNS Write",
        "Workers Scripts Write",
        "Workers Routes Write",
        "Containers Write",
      ],
    });
    expect(
      (await cloudflare(context(container, cloudflareEnv))).every(
        (finding) => finding.severity === "ok",
      ),
    ).toBe(true);
  });

  it("tells the owner to move the nameservers when the zone is still pending", async () => {
    cloudflareApi({ permissions: ["DNS Write"], zoneStatus: "pending" });
    const findings = await cloudflare(context(vercel, cloudflareEnv));
    expect(findings).toContainEqual({
      check: "cloudflare",
      severity: "fail",
      message: "zone turbovibe.ai is pending, not active",
      fix: "point turbovibe.ai's nameservers at Cloudflare (ada.ns.cloudflare.com, bob.ns.cloudflare.com) at your registrar",
    });
  });

  it("requires Workers Paid for Containers", async () => {
    cloudflareApi({
      permissions: [
        "DNS Write",
        "Workers Scripts Write",
        "Workers Routes Write",
        "Containers Write",
      ],
      plan: "free",
    });
    expect(await cloudflare(context(container, cloudflareEnv))).toContainEqual(
      expect.objectContaining({
        severity: "fail",
        fix: "subscribe to Workers Paid ($5/month) in Workers & Pages → Plans",
      }),
    );
  });

  it("leaves account-wide permissions to the state bucket's report when the account ID is missing", async () => {
    cloudflareApi({
      permissions: [
        "DNS Write",
        "Workers Scripts Write",
        "Workers Routes Write",
        "Containers Write",
      ],
    });
    const { CLOUDFLARE_ACCOUNT_ID: _, ...withoutAccount } = cloudflareEnv;
    const findings = await cloudflare(context(container, withoutAccount));
    expect(findings.filter((finding) => finding.severity === "fail")).toEqual(
      [],
    );
    expect(findings.map((finding) => finding.message)).not.toContain(
      "CLOUDFLARE_API_TOKEN has Containers Write",
    );
  });

  it("names each missing variable instead of calling the API", async () => {
    const findings = await cloudflare(
      context(container, { CLOUDFLARE_API_TOKEN: "x" }),
    );
    expect(findings.map((finding) => finding.message)).toEqual([
      "CLOUDFLARE_ZONE_ID is not set",
    ]);
  });

  const stateEnv = {
    TURBO_VIBE_STATE_BUCKET: "tv-state",
    AWS_ACCESS_KEY_ID: "id",
    AWS_SECRET_ACCESS_KEY: "secret",
    CLOUDFLARE_ACCOUNT_ID: "acc123",
  };
  function r2({ enforces }: { enforces: boolean }) {
    const objects = new Set<string>();
    const deleted: string[] = [];
    server.use(
      http.put(
        "https://acc123.r2.cloudflarestorage.com/tv-state/*",
        ({ request }) => {
          const key = new URL(request.url).pathname;
          if (
            enforces &&
            request.headers.get("if-none-match") === "*" &&
            objects.has(key)
          ) {
            return new HttpResponse(null, { status: 412 });
          }
          objects.add(key);
          return new HttpResponse(null, { status: 200 });
        },
      ),
      http.delete(
        "https://acc123.r2.cloudflarestorage.com/tv-state/*",
        ({ request }) => {
          deleted.push(new URL(request.url).pathname);
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    return { deleted };
  }

  it("trusts a bucket that rejects a second conditional create, and cleans up its probe", async () => {
    const { deleted } = r2({ enforces: true });
    const findings = await stateBucket(context(db, stateEnv));
    expect(findings).toEqual([
      ok(
        "state bucket",
        "bucket tv-state rejects a second conditional create, so state locking is safe",
      ),
    ]);
    expect(deleted).toEqual([
      expect.stringMatching(/^\/tv-state\/acme\/check\/lock-probe-\d+$/),
    ]);
  });

  it("reports a bucket that accepts a second conditional create as unsafe", async () => {
    r2({ enforces: false });
    const [finding] = await stateBucket(context(db, stateEnv));
    expect(finding).toMatchObject({
      severity: "fail",
      message:
        "bucket tv-state accepted a second conditional create (HTTP 200), so two runs could hold the state lock at once",
    });
  });
});
