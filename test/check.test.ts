import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  cloudflare,
  requiredPermissions,
  zoneScoped,
} from "../src/checks/cloudflare.js";
import { localTools, npmLockfile } from "../src/checks/local.js";
import { stateBucket } from "../src/checks/state.js";
import type { CheckContext, Finding } from "../src/checks/types.js";
import { fail, ok, warn } from "../src/checks/types.js";
import { github, supabase, vercel, workos } from "../src/checks/vendors.js";
import { parseConfig } from "../src/config/load.js";
import type { Config, EnvironmentName } from "../src/config/schema.js";
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
const vercelSite =
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
      "supabase",
      "github",
    ]);
    expect(checksFor(config(container)).map((check) => check.name)).toContain(
      "cloudflare",
    );
    expect(checksFor(config(vercelSite)).map((check) => check.name)).toContain(
      "cloudflare",
    );
  });

  it("asks a Vercel-only project's token for DNS alone, and a container project's for Workers, zone settings and Containers too", () => {
    expect(requiredPermissions(context(vercelSite))).toEqual(["DNS Write"]);
    expect(requiredPermissions(context(container))).toEqual([
      "DNS Write",
      "Workers Scripts Write",
      "Workers Routes Write",
      "Access: Apps and Policies Write",
      "Zone Settings Write",
      "Workers Containers Write",
    ]);
  });
});

describe("check", () => {
  const io = context(container).io;
  it("exits non-zero when any check fails", async () => {
    const { check } = await import("../src/check.js");
    const code = await check(config(container), "staging", io, {
      nodeVersion: "24.12.0",
      checks: [
        async () => [
          ok("node", "Node 24"),
          fail("cloudflare", "token lacks DNS Write", "add it"),
        ],
      ],
    });
    expect(code).toBe(1);
  });

  it("exits zero when nothing fails, warnings included", async () => {
    const { check } = await import("../src/check.js");
    const code = await check(config(container), "staging", io, {
      nodeVersion: "24.12.0",
      checks: [
        async () => [ok("node", "Node 24"), warn("vercel", "Hobby plan")],
      ],
    });
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
  type Grant = {
    name: string;
    zone?: string;
    effect?: "allow" | "deny";
    account?: boolean;
  };
  function policy({
    name,
    zone = "zone456",
    effect = "allow",
    account = false,
  }: Grant) {
    return {
      effect,
      permission_groups: [{ name }],
      resources:
        zoneScoped.has(name) && !account
          ? { [`com.cloudflare.api.account.zone.${zone}`]: "*" }
          : { "com.cloudflare.api.account.acc123": "*" },
    };
  }
  function cloudflareApi({
    permissions,
    zoneStatus = "active",
    plan = "workers_paid",
    owner = "user",
  }: {
    permissions: (string | Grant)[];
    zoneStatus?: string;
    plan?: string;
    owner?: "user" | "account";
  }) {
    const tokens =
      owner === "user"
        ? "https://api.cloudflare.com/client/v4/user/tokens"
        : "https://api.cloudflare.com/client/v4/accounts/acc123/tokens";
    server.use(
      http.get("https://api.cloudflare.com/client/v4/user/tokens/verify", () =>
        owner === "user"
          ? envelope({ id: "tok1", status: "active" })
          : HttpResponse.json(
              { success: false, errors: [{ code: 1000 }], result: null },
              { status: 401 },
            ),
      ),
      http.get(`${tokens}/verify`, () =>
        envelope({ id: "tok1", status: "active" }),
      ),
      http.get(`${tokens}/tok1`, () =>
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
          "Access: Apps and Policies Write",
          "Zone Settings Write",
          "Workers Containers Write",
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

  it("fails a staging token without Zone Settings Write and names the zone, but asks a preview token for none", async () => {
    cloudflareApi({
      permissions: [
        "DNS Write",
        "Workers Scripts Write",
        "Workers Routes Write",
        "Access: Apps and Policies Write",
        "Workers Containers Write",
      ],
    });
    const failures = (
      await cloudflare(context(container, cloudflareEnv))
    ).filter((finding) => finding.severity === "fail");
    expect(failures.map((finding) => finding.message)).toEqual([
      "CLOUDFLARE_API_TOKEN lacks Zone Settings Write on turbovibe.ai",
    ]);
    expect(
      requiredPermissions({ ...context(container), environment: "preview" }),
    ).not.toContain("Zone Settings Write");
  });

  it("accepts a preview token without Zone Settings Write when setup checks it as staging-kind", async () => {
    cloudflareApi({
      permissions: [
        "DNS Write",
        "Workers Scripts Write",
        "Workers Routes Write",
        "Access: Apps and Policies Write",
        "Workers Containers Write",
      ],
    });
    const findings = await cloudflare({
      ...context(container, cloudflareEnv),
      githubEnvironment: "preview",
    });
    expect(findings.every((finding) => finding.severity === "ok")).toBe(true);
  });

  it("asks for Account Settings Write and Read only for the staging and production tokens of environments that count visits", () => {
    const parsed = parseConfig(
      "version: 1\nproject: acme\ndomain: app.turbovibe.ai\nenvironments:\n  production:\n    analytics: true\n  staging:\n    analytics: true\nservices:\n  web:\n    kind: frontend\n    target: cloudflare-static\n    build: { command: x, output: dist }\n",
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    for (const environment of ["production", "staging"])
      expect(
        requiredPermissions({ config: parsed.config, environment }),
        environment,
      ).toEqual(
        expect.arrayContaining([
          "Account Settings Write",
          "Account Settings Read",
        ]),
      );
    for (const environment of ["preview", "live"]) {
      const permissions = requiredPermissions({
        config: parsed.config,
        environment,
      });
      expect(permissions, environment).not.toContain("Account Settings Write");
      expect(permissions, environment).not.toContain("Account Settings Read");
    }
  });

  describe("a private environment", () => {
    const site =
      "  web:\n    kind: frontend\n    target: cloudflare-static\n    build: { command: x, output: dist }\n";
    const privateContext = () => {
      const base = context(site, cloudflareEnv);
      const parsed = parseConfig(
        `version: 1\nproject: acme\ndomain: app.turbovibe.ai\nenvironments:\n  staging:\n    access: { emails: [ada@example.com] }\nservices:\n${site}`,
      );
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
      return { ...base, config: parsed.config };
    };
    const granted = [
      "DNS Write",
      "Workers Scripts Write",
      "Workers Routes Write",
      "Access: Apps and Policies Write",
      "Zone Settings Write",
    ];
    const zeroTrust = (enabled: boolean) =>
      server.use(
        http.get(
          "https://api.cloudflare.com/client/v4/zones/zone456/access/apps",
          () =>
            enabled
              ? envelope([])
              : HttpResponse.json(
                  { success: false, errors: [{ code: 9999 }], result: null },
                  { status: 403 },
                ),
        ),
      );

    it("asks every token for Access on the zone, private or not", () => {
      expect(requiredPermissions(privateContext())).toEqual(granted);
      expect(
        requiredPermissions({ ...privateContext(), environment: "production" }),
      ).toContain("Access: Apps and Policies Write");
      expect(zoneScoped.has("Access: Apps and Policies Write")).toBe(true);
      expect(requiredPermissions(privateContext())).not.toContain(
        "Access: Service Tokens Write",
      );
    });

    it("accepts Access on the account, as turbo-vibe 1.0 granted it, and probes Zero Trust there", async () => {
      cloudflareApi({
        permissions: [
          ...granted.filter(
            (permission) => permission !== "Access: Apps and Policies Write",
          ),
          { name: "Access: Apps and Policies Write", account: true },
        ],
      });
      server.use(
        http.get(
          "https://api.cloudflare.com/client/v4/accounts/acc123/access/apps",
          () => envelope([]),
        ),
      );
      const findings = await cloudflare(privateContext());
      expect(findings.every((finding) => finding.severity === "ok")).toBe(true);
      expect(findings.map((finding) => finding.message)).toContain(
        "Zero Trust is enabled, so Access can keep staging private",
      );
    });

    it("does not ask a public environment's token for Access", async () => {
      cloudflareApi({
        permissions: granted.filter(
          (permission) => permission !== "Access: Apps and Policies Write",
        ),
      });
      const findings = await cloudflare({
        ...privateContext(),
        environment: "production",
      });
      expect(findings.every((finding) => finding.severity === "ok")).toBe(true);
    });

    it("confirms Zero Trust is enabled", async () => {
      cloudflareApi({ permissions: granted });
      zeroTrust(true);
      const findings = await cloudflare(privateContext());
      expect(findings.every((finding) => finding.severity === "ok")).toBe(true);
      expect(findings.map((finding) => finding.message)).toContain(
        "Zero Trust is enabled, so Access can keep staging private",
      );
    });

    it("names the missing Access permission without blaming Zero Trust", async () => {
      cloudflareApi({
        permissions: granted.filter(
          (permission) => permission !== "Access: Apps and Policies Write",
        ),
      });
      zeroTrust(false);
      const messages = (await cloudflare(privateContext()))
        .filter((finding) => finding.severity === "fail")
        .map((finding) => finding.message);
      expect(messages).toEqual([
        "CLOUDFLARE_API_TOKEN lacks Access: Apps and Policies Write on turbovibe.ai",
      ]);
    });

    it("sends the person to enable Zero Trust when Access is unavailable", async () => {
      cloudflareApi({ permissions: granted });
      zeroTrust(false);
      expect(
        (await cloudflare(privateContext())).filter(
          (finding) => finding.severity === "fail",
        ),
      ).toEqual([
        {
          check: "cloudflare",
          severity: "fail",
          message:
            "staging is private, but Cloudflare Access is not available on the account (HTTP 403)",
          fix: "open https://one.dash.cloudflare.com/, choose a team name and the Free plan (it asks for payment details but does not charge), then run check again",
        },
      ]);
    });
  });

  it("names the token, the missing DNS permission, and the domain", async () => {
    cloudflareApi({
      permissions: [
        "Workers Scripts Write",
        "Workers Routes Write",
        "Access: Apps and Policies Write",
        "Zone Settings Write",
        "Workers Containers Write",
      ],
    });
    const findings = await cloudflare(context(container, cloudflareEnv));
    expect(findings.filter((finding) => finding.severity === "fail")).toEqual([
      {
        check: "cloudflare",
        severity: "fail",
        message: "CLOUDFLARE_API_TOKEN lacks DNS Write on turbovibe.ai",
        fix: 'run setup and answer y to "Add missing permissions to the Cloudflare CI tokens?", which updates the token in place; or edit the token in Cloudflare → My Profile → API Tokens and add DNS Write for zone turbovibe.ai',
      },
    ]);
  });

  it("is satisfied when the token, zone, and plan are in place", async () => {
    cloudflareApi({
      permissions: [
        "DNS Write",
        "Workers Scripts Write",
        "Workers Routes Write",
        "Access: Apps and Policies Write",
        "Zone Settings Write",
        "Workers Containers Write",
      ],
    });
    expect(
      (await cloudflare(context(container, cloudflareEnv))).every(
        (finding) => finding.severity === "ok",
      ),
    ).toBe(true);
  });

  it("accepts an account-owned token", async () => {
    cloudflareApi({
      owner: "account",
      permissions: [
        "DNS Write",
        "Workers Scripts Write",
        "Workers Routes Write",
        "Access: Apps and Policies Write",
        "Zone Settings Write",
        "Workers Containers Write",
      ],
    });
    expect(
      (await cloudflare(context(container, cloudflareEnv))).every(
        (finding) => finding.severity === "ok",
      ),
    ).toBe(true);
  });

  it("does not take the older Cloudchamber Write for Workers Containers Write, which wrangler's deploy needs", async () => {
    cloudflareApi({
      owner: "account",
      permissions: [
        "DNS Write",
        "Workers Scripts Write",
        "Workers Routes Write",
        "Access: Apps and Policies Write",
        "Zone Settings Write",
        "Cloudchamber Write",
      ],
    });
    const failures = (
      await cloudflare(context(container, cloudflareEnv))
    ).filter((finding) => finding.severity === "fail");
    expect(failures.map((finding) => finding.message)).toEqual([
      "CLOUDFLARE_API_TOKEN lacks Workers Containers Write",
    ]);
  });

  it("points a missing permission on an account-owned token to the account's token page", async () => {
    cloudflareApi({
      owner: "account",
      permissions: ["Workers Scripts Write", "Workers Routes Write"],
    });
    const findings = await cloudflare(context(vercelSite, cloudflareEnv));
    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "fail",
        fix: 'run setup and answer y to "Add missing permissions to the Cloudflare CI tokens?", which updates the token in place; or edit the token in Cloudflare → Manage Account → Account API Tokens and add DNS Write for zone turbovibe.ai',
      }),
    );
  });

  it("tells the owner to move the nameservers when the zone is still pending", async () => {
    cloudflareApi({ permissions: ["DNS Write"], zoneStatus: "pending" });
    const findings = await cloudflare(context(vercelSite, cloudflareEnv));
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
        "Access: Apps and Policies Write",
        "Zone Settings Write",
        "Workers Containers Write",
      ],
      plan: "free",
    });
    expect(await cloudflare(context(container, cloudflareEnv))).toContainEqual(
      expect.objectContaining({
        severity: "fail",
        fix: "subscribe to Workers Paid in Workers & Pages → Plans",
      }),
    );
  });

  it("leaves account-wide permissions to the state bucket's report when the account ID is missing", async () => {
    cloudflareApi({
      permissions: [
        "DNS Write",
        "Workers Scripts Write",
        "Workers Routes Write",
        "Access: Apps and Policies Write",
        "Zone Settings Write",
        "Workers Containers Write",
      ],
    });
    const { CLOUDFLARE_ACCOUNT_ID: _, ...withoutAccount } = cloudflareEnv;
    const findings = await cloudflare(context(container, withoutAccount));
    expect(findings.filter((finding) => finding.severity === "fail")).toEqual(
      [],
    );
    expect(findings.map((finding) => finding.message)).not.toContain(
      "CLOUDFLARE_API_TOKEN has Workers Containers Write",
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

  describe("build records in production", () => {
    const production = (env: Record<string, string>) => ({
      ...context(db, env),
      environment: "production" as const,
    });

    it("confirms that production can read staging's bucket", async () => {
      r2({ enforces: true });
      server.use(
        http.get(
          "https://acc123.r2.cloudflarestorage.com/staging-state/",
          () =>
            new HttpResponse(
              "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
            ),
        ),
      );
      const findings = await stateBucket(
        production({ ...stateEnv, TURBO_VIBE_BUILDS_BUCKET: "staging-state" }),
      );
      expect(findings.at(-1)).toEqual(
        ok(
          "build records",
          "production can read build records in staging-state",
        ),
      );
    });

    it("fails when production's token cannot read staging's bucket", async () => {
      r2({ enforces: true });
      server.use(
        http.get(
          "https://acc123.r2.cloudflarestorage.com/staging-state/",
          () => new HttpResponse("AccessDenied", { status: 403 }),
        ),
      );
      const finding = (
        await stateBucket(
          production({
            ...stateEnv,
            TURBO_VIBE_BUILDS_BUCKET: "staging-state",
          }),
        )
      ).at(-1);
      expect(finding).toMatchObject({
        check: "build records",
        severity: "fail",
        fix: "give production's R2 token Object Read on staging-state",
      });
    });

    it("names a missing builds bucket", async () => {
      r2({ enforces: true });
      const finding = (await stateBucket(production(stateEnv))).at(-1);
      expect(finding).toMatchObject({
        severity: "fail",
        unset: ["TURBO_VIBE_BUILDS_BUCKET"],
      });
    });

    it("does not look for build records outside production", async () => {
      r2({ enforces: true });
      const findings = await stateBucket(context(db, stateEnv));
      expect(findings.map((finding) => finding.check)).toEqual([
        "state bucket",
      ]);
    });
  });

  describe("supabase", () => {
    const token = { SUPABASE_ACCESS_TOKEN: "sbp_token" };
    function supabaseApi(
      plan: string,
      projects: { name: string; status: string }[],
    ) {
      server.use(
        http.get("https://api.supabase.com/v1/organizations/acme", () =>
          HttpResponse.json({ id: "acme", plan }),
        ),
        http.get("https://api.supabase.com/v1/projects", () =>
          HttpResponse.json(
            projects.map((project, index) => ({
              id: `ref${index}`,
              organization_id: "acme",
              ...project,
            })),
          ),
        ),
      );
    }

    it("reads the organization from SUPABASE_ORGANIZATION when the file leaves it out, and names it when both are missing", async () => {
      supabaseApi("free", [{ name: "acme-db-staging", status: "INACTIVE" }]);
      const withoutOrganization = db.replace("    organization: acme\n", "");
      expect(
        await supabase(
          context(withoutOrganization, {
            ...token,
            SUPABASE_ORGANIZATION: "acme",
          }),
        ),
      ).toContainEqual(
        expect.objectContaining({
          message: "project acme-db-staging is paused",
        }),
      );
      expect(await supabase(context(withoutOrganization, token))).toEqual([
        expect.objectContaining({
          severity: "fail",
          message: "SUPABASE_ORGANIZATION is not set",
        }),
      ]);
    });

    it("reports a paused project as paused, with how to restore it", async () => {
      supabaseApi("free", [{ name: "acme-db-staging", status: "INACTIVE" }]);
      expect(await supabase(context(db, token))).toContainEqual(
        expect.objectContaining({
          severity: "fail",
          message: "project acme-db-staging is paused",
        }),
      );
    });

    it("stops a free organization from needing a third active project", async () => {
      supabaseApi("free", [
        { name: "blog-db-staging", status: "ACTIVE_HEALTHY" },
        { name: "blog-db-production", status: "ACTIVE_HEALTHY" },
      ]);
      expect(await supabase(context(db, token))).toContainEqual(
        expect.objectContaining({
          severity: "fail",
          message:
            "organization acme already has 2 active projects, and the free plan allows two",
        }),
      );
    });

    it("refuses staging as a branch when the organization is really on the free plan", async () => {
      supabaseApi("free", []);
      const branched = `${db}    plan: paid\n    staging: branch\n`;
      expect((await supabase(context(branched, token)))[0]).toMatchObject({
        severity: "fail",
        message:
          "organization acme is on the free plan, but the config says plan: paid and staging: branch",
      });
    });

    it("warns, instead of passing, when it cannot list the projects", async () => {
      server.use(
        http.get("https://api.supabase.com/v1/organizations/acme", () =>
          HttpResponse.json({ id: "acme", plan: "free" }),
        ),
        http.get("https://api.supabase.com/v1/projects", () =>
          HttpResponse.json({ message: "rate limited" }, { status: 429 }),
        ),
      );
      expect(await supabase(context(db, token))).toContainEqual(
        expect.objectContaining({
          severity: "warn",
          message:
            "cannot list projects to check for paused ones or the free plan's limit (HTTP 429)",
        }),
      );
    });

    it("is satisfied by a healthy project within the plan", async () => {
      supabaseApi("pro", [
        { name: "acme-db-staging", status: "ACTIVE_HEALTHY" },
      ]);
      expect(
        (await supabase(context(db, token))).every(
          (finding) => finding.severity === "ok",
        ),
      ).toBe(true);
    });
  });

  describe("workos", () => {
    const auth = "  auth:\n    kind: identity\n    target: workos\n";
    const accepting = () =>
      server.use(
        http.get(
          "https://api.workos.com/user_management/redirect_uris",
          ({ request }) =>
            request.headers.get("authorization")?.endsWith("_good")
              ? HttpResponse.json({ data: [], list_metadata: {} })
              : new HttpResponse(null, { status: 401 }),
        ),
      );

    it("refuses a production key on staging", async () => {
      accepting();
      const findings = await workos(
        context(container + auth, {
          WORKOS_API_KEY: "sk_live_good",
          WORKOS_CLIENT_ID: "client_1",
        }),
      );
      expect(findings[0]).toMatchObject({
        severity: "fail",
        message:
          "WORKOS_API_KEY is not a staging key (it should start with sk_test_)",
      });
    });

    it("reports a key WorkOS rejects", async () => {
      accepting();
      const findings = await workos(
        context(container + auth, {
          WORKOS_API_KEY: "sk_test_revoked",
          WORKOS_CLIENT_ID: "client_1",
        }),
      );
      expect(findings).toContainEqual(
        expect.objectContaining({
          severity: "fail",
          message: "WorkOS rejects WORKOS_API_KEY (HTTP 401)",
        }),
      );
    });

    it("accepts the staging environment's valid key", async () => {
      accepting();
      const findings = await workos(
        context(container + auth, {
          WORKOS_API_KEY: "sk_test_good",
          WORKOS_CLIENT_ID: "client_1",
        }),
      );
      expect(findings).toEqual([ok("workos", "WORKOS_API_KEY is valid")]);
    });
  });

  describe("vercel", () => {
    const vercelEnv = { VERCEL_API_TOKEN: "v", VERCEL_TEAM_ID: "team_1" };
    const team = (status: number, plan?: string) =>
      server.use(
        http.get("https://api.vercel.com/v2/teams/team_1", () =>
          status === 200
            ? HttpResponse.json({ id: "team_1", billing: { plan } })
            : new HttpResponse(null, { status }),
        ),
      );

    it("warns that Hobby forbids commercial use, without failing", async () => {
      team(200, "hobby");
      expect(await vercel(context(vercelSite, vercelEnv))).toEqual([
        warn(
          "vercel",
          "the team is on Hobby, which forbids commercial use",
          "upgrade the team to Pro for a commercial project",
        ),
      ]);
    });

    it("warns when the team's plan cannot be read, rather than calling it fine", async () => {
      server.use(
        http.get("https://api.vercel.com/v2/teams/team_1", () =>
          HttpResponse.json({ id: "team_1" }),
        ),
      );
      expect((await vercel(context(vercelSite, vercelEnv)))[0]).toMatchObject({
        severity: "warn",
        message: "could not read the team's plan",
      });
    });

    it("fails when the token cannot read the team", async () => {
      team(403);
      expect((await vercel(context(vercelSite, vercelEnv)))[0]?.severity).toBe(
        "fail",
      );
    });
  });

  describe("github", () => {
    const githubEnv = { GITHUB_TOKEN: "ghp", GITHUB_REPOSITORY: "acme/app" };
    function repo(
      environment: string,
      rules: string[],
      secrets: string[],
      promote?: string,
    ) {
      server.use(
        http.get(
          "https://api.github.com/repos/acme/app/actions/variables/TURBO_VIBE_PROMOTE_FROM_STAGING",
          () =>
            promote === undefined
              ? HttpResponse.json({ message: "Not Found" }, { status: 404 })
              : HttpResponse.json({
                  name: "TURBO_VIBE_PROMOTE_FROM_STAGING",
                  value: promote,
                }),
        ),
        http.get(
          `https://api.github.com/repos/acme/app/environments/${environment}`,
          () =>
            HttpResponse.json({
              name: environment,
              protection_rules: rules.map((type) => ({ type })),
            }),
        ),
        http.get(
          `https://api.github.com/repos/acme/app/environments/${environment}/secrets`,
          () =>
            HttpResponse.json({ secrets: secrets.map((name) => ({ name })) }),
        ),
      );
    }

    it("reads the GitHub environment it is given, such as live, while checking it as staging", async () => {
      repo("live", [], ["AWS_ACCESS_KEY_ID"]);
      const findings = await github({
        ...context(container, githubEnv),
        githubEnvironment: "live",
      });
      expect(findings).toContainEqual(
        expect.objectContaining({
          severity: "fail",
          message: expect.stringMatching(/^the live environment is missing /),
        }),
      );
    });

    it("only warns when it has no token to look with", async () => {
      expect((await github(context(container)))[0]?.severity).toBe("warn");
    });

    it("names a missing environment", async () => {
      server.use(
        http.get(
          "https://api.github.com/repos/acme/app/environments/staging",
          () => new HttpResponse(null, { status: 404 }),
        ),
      );
      expect(await github(context(container, githubEnv))).toEqual([
        fail(
          "github",
          "acme/app has no staging environment",
          "create it in Settings → Environments → New environment",
        ),
      ]);
    });

    it("warns, rather than blaming the reviewers, when the token cannot read the environment", async () => {
      server.use(
        http.get(
          "https://api.github.com/repos/acme/app/environments/production",
          () => new HttpResponse(null, { status: 403 }),
        ),
      );
      const production = {
        ...context(container, githubEnv),
        environment: "production" as const,
      };
      expect(await github(production)).toEqual([
        warn(
          "github",
          "cannot read the production environment (HTTP 403)",
          "use a GITHUB_TOKEN that can read the repository's environments",
        ),
      ]);
    });

    it("is satisfied by a reviewed production environment with every secret", async () => {
      repo(
        "production",
        ["required_reviewers"],
        [
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
          "CLOUDFLARE_ACCOUNT_ID",
          "CLOUDFLARE_API_TOKEN",
          "CLOUDFLARE_ZONE_ID",
          "TURBO_VIBE_BUILDS_BUCKET",
          "TURBO_VIBE_STATE_BUCKET",
        ],
      );
      const production = {
        ...context(container, githubEnv),
        environment: "production" as const,
      };
      expect(
        (await github(production)).every(
          (finding) => finding.severity === "ok",
        ),
      ).toBe(true);
    });

    it("lets a private repository without reviewers pass, with a warning", async () => {
      repo(
        "production",
        [],
        [
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
          "CLOUDFLARE_ACCOUNT_ID",
          "CLOUDFLARE_API_TOKEN",
          "CLOUDFLARE_ZONE_ID",
          "TURBO_VIBE_BUILDS_BUCKET",
          "TURBO_VIBE_STATE_BUCKET",
        ],
      );
      const production = {
        ...context(container, githubEnv),
        environment: "production" as const,
      };
      expect(
        (await github(production)).map((finding) => finding.severity).sort(),
      ).toEqual(["ok", "warn"]);
    });

    it("fails a production that promotes from staging without a reviewer, and passes it with one", async () => {
      const secrets = [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_ZONE_ID",
        "TURBO_VIBE_BUILDS_BUCKET",
        "TURBO_VIBE_STATE_BUCKET",
      ];
      const production = {
        ...context(container, githubEnv),
        environment: "production" as const,
      };
      repo("production", [], secrets, "true");
      expect(await github(production)).toContainEqual({
        severity: "fail",
        check: "github",
        message:
          "TURBO_VIBE_PROMOTE_FROM_STAGING is true but production has no required reviewer, so every Staging run's production job stops before deploying",
        fix: "add a reviewer in Settings → Environments → production, or delete the repository variable TURBO_VIBE_PROMOTE_FROM_STAGING",
      });
      repo("production", ["required_reviewers"], secrets, "true");
      expect(
        (await github(production)).map((finding) => finding.severity),
      ).toEqual(["ok", "ok"]);
    });

    it("names a build secret the repository lacks", async () => {
      repo("production", ["required_reviewers"], []);
      server.use(
        http.get("https://api.github.com/repos/acme/app/actions/secrets", () =>
          HttpResponse.json({ secrets: [{ name: "OTHER" }] }),
        ),
      );
      const findings = await github({
        ...context(
          container.replace(
            "build: { dockerfile: Dockerfile }",
            "build: { dockerfile: Dockerfile, secrets: [NPM_TOKEN] }",
          ),
          githubEnv,
        ),
        environment: "production" as const,
      });
      expect(findings).toContainEqual(
        expect.objectContaining({
          severity: "fail",
          message: "the repository is missing the build secrets NPM_TOKEN",
        }),
      );
    });

    it("names a public value that production lacks among its variables", async () => {
      repo("production", ["required_reviewers"], []);
      server.use(
        http.get(
          "https://api.github.com/repos/acme/app/environments/production/variables",
          () => HttpResponse.json({ variables: [{ name: "OTHER" }] }),
        ),
      );
      const findings = await github({
        ...context(
          `${container}  web:\n    kind: frontend\n    target: cloudflare-static\n    serve_with: api\n    public: [VITE_POSTHOG_KEY]\n    build: { command: x, output: dist }\n`,
          githubEnv,
        ),
        environment: "production" as const,
      });
      expect(findings).toContainEqual(
        expect.objectContaining({
          severity: "fail",
          message:
            "the production environment is missing the public values VITE_POSTHOG_KEY",
        }),
      );
    });

    it("names a declared secret that production lacks", async () => {
      repo("production", ["required_reviewers"], []);
      const findings = await github({
        ...context(
          container.replace(
            "    target: cloudflare-container\n",
            "    target: cloudflare-container\n    secrets: [STRIPE_SECRET_KEY]\n",
          ),
          githubEnv,
        ),
        environment: "production" as const,
      });
      expect(findings).toContainEqual(
        expect.objectContaining({
          severity: "fail",
          message: expect.stringMatching(
            /^the production environment is missing .*STRIPE_SECRET_KEY/,
          ),
        }),
      );
    });

    it("warns, without failing, when production has no reviewers, and names the secrets it lacks", async () => {
      repo("production", [], ["CLOUDFLARE_API_TOKEN"]);
      const production = {
        ...context(container, githubEnv),
        environment: "production" as const,
      };
      const findings = await github(production);
      expect(
        findings.map((finding) => [finding.severity, finding.message]),
      ).toEqual([
        [
          "warn",
          "production has no required reviewers, so the typed build-ID confirmation is the only safeguard before promotion",
        ],
        [
          "fail",
          "the production environment is missing AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, TURBO_VIBE_BUILDS_BUCKET, TURBO_VIBE_STATE_BUCKET",
        ],
      ]);
    });
  });
});

describe("npmLockfile", () => {
  const site = (command: string) =>
    `  web:\n    kind: frontend\n    target: cloudflare-static\n    build: { command: "${command}", output: dist }\n`;
  const npm = (code: number, stdout: string) =>
    vi.fn(async () => ({ code, stdout }));
  async function lockfileCheck(
    capture: Io["capture"],
    {
      lockfile = true,
      environment = "staging",
    }: { lockfile?: boolean; environment?: EnvironmentName } = {},
  ) {
    const configDir = await mkdtemp(join(tmpdir(), "turbo-vibe-lockfile-"));
    if (lockfile) await writeFile(join(configDir, "package-lock.json"), "{}");
    const base = context(site("npm ci && npm run build"), {}, { capture });
    return npmLockfile({ ...base, environment, configDir });
  }

  it("passes when npm ci accepts the lockfile, asking npm without installing", async () => {
    const capture = npm(0, '{"add":[]}');
    const findings = await lockfileCheck(capture);
    expect(findings).toEqual([
      ok("lockfile", "web: npm ci accepts the lockfile in ."),
    ]);
    expect(capture).toHaveBeenCalledWith(
      "npm",
      [
        "ci",
        "--dry-run",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--json",
      ],
      expect.objectContaining({ quiet: true }),
    );
  });

  it("fails when npm ci refuses a lockfile that does not match package.json", async () => {
    const findings = await lockfileCheck(
      npm(1, '{"error":{"code":"EUSAGE","summary":"not in sync"}}'),
    );
    expect(findings).toEqual([
      fail(
        "lockfile",
        "web: npm ci refuses the lockfile in ., which does not match package.json",
        "run npm install in . and commit package-lock.json",
      ),
    ]);
  });

  it("asks npm when the lockfile sits in a workspace root above build.root", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "turbo-vibe-lockfile-"));
    await writeFile(join(configDir, "package-lock.json"), "{}");
    const capture = npm(0, '{"add":[]}');
    const base = context(
      '  web:\n    kind: frontend\n    target: vercel-nextjs\n    build: { command: "npm ci", root: apps/web }\n',
      {},
      { capture },
    );
    const findings = await npmLockfile({ ...base, configDir });
    expect(findings).toEqual([
      ok("lockfile", "web: npm ci accepts the lockfile in apps/web"),
    ]);
    expect(capture).toHaveBeenCalledWith(
      "npm",
      expect.anything(),
      expect.objectContaining({ cwd: join(configDir, "apps/web") }),
    );
  });

  it("does not look above a build.root outside the config folder", async () => {
    const parent = await mkdtemp(join(tmpdir(), "turbo-vibe-lockfile-"));
    await writeFile(join(parent, "package-lock.json"), "{}");
    const capture = npm(0, "");
    const base = context(
      '  web:\n    kind: frontend\n    target: vercel-nextjs\n    build: { command: "npm ci", root: ../site-web }\n',
      {},
      { capture },
    );
    const findings = await npmLockfile({
      ...base,
      configDir: join(parent, "site"),
    });
    expect(findings[0]?.message).toContain("has no package-lock.json");
    expect(capture).not.toHaveBeenCalled();
  });

  it("fails without asking npm when there is no lockfile", async () => {
    const capture = npm(0, "");
    const findings = await lockfileCheck(capture, { lockfile: false });
    expect(findings[0]?.severity).toBe("fail");
    expect(findings[0]?.message).toContain("has no package-lock.json");
    expect(capture).not.toHaveBeenCalled();
  });

  it("only warns when npm cannot answer, such as without a network or without npm", async () => {
    const offline = await lockfileCheck(
      npm(1, '{"error":{"code":"ENOTCACHED"}}'),
    );
    expect(offline[0]?.severity).toBe("warn");
    expect(offline[0]?.message).toContain("(ENOTCACHED)");
    const missing = await lockfileCheck(
      vi.fn(async () => {
        throw new Error("spawn npm ENOENT");
      }),
    );
    expect(missing[0]?.severity).toBe("warn");
  });

  it("skips production, which deploys staging's build", async () => {
    const capture = npm(0, "");
    expect(await lockfileCheck(capture, { environment: "production" })).toEqual(
      [],
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("runs only for a frontend that installs with npm ci", () => {
    expect(checksFor(config(site("npm ci && npm run build")))).toContain(
      npmLockfile,
    );
    expect(
      checksFor(
        config(site("corepack enable && pnpm install --frozen-lockfile")),
      ),
    ).not.toContain(npmLockfile);
  });
});
