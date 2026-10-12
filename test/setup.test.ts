import { beforeEach, describe, expect, it, vi } from "vitest";
import { granted, requiredPermissions } from "../src/checks/cloudflare.js";
import { stateBucket } from "../src/checks/state.js";
import type { Check } from "../src/checks/types.js";
import { fail, missing, ok } from "../src/checks/types.js";
import { parseConfig } from "../src/config/load.js";
import type { Io } from "../src/io.js";
import type { Capturer } from "../src/run.js";
import { project, run } from "./harness.js";

const checks = vi.hoisted(() => ({ list: [] as Check[] }));
vi.mock("../src/check.js", async (original) => ({
  ...(await original<typeof import("../src/check.js")>()),
  checksFor: () => checks.list,
}));

beforeEach(() => {
  checks.list = [];
});

interface FakeGitHub {
  signedIn?: boolean;
  installed?: boolean;
  environments?: Record<string, object | "unreadable">;
  refuseReviewers?: boolean;
  userReadable?: boolean;
  secrets?: Record<string, string[]>;
}

function fakeGh({
  signedIn = true,
  installed = true,
  environments = {},
  refuseReviewers = false,
  userReadable = true,
  secrets = {},
}: FakeGitHub = {}) {
  const envs = new Map(Object.entries(environments));
  const stored: { env: string; name: string; value: string | undefined }[] = [];
  const capture = vi.fn<Capturer>(async (command, args, options) => {
    if (command !== "gh") return { code: 0, stdout: "{}" };
    if (!installed) throw new Error("spawn gh ENOENT");
    const [first, ...rest] = args;
    if (first === "secret") {
      const env = args[args.indexOf("--env") + 1] ?? "";
      if (rest[0] === "list")
        return {
          code: 0,
          stdout: JSON.stringify(
            (secrets[env] ?? []).map((name) => ({ name })),
          ),
        };
      stored.push({ env, name: rest[1] ?? "", value: options.input });
      return { code: 0, stdout: "" };
    }
    if (first === "auth" && rest[0] === "token")
      return { code: 0, stdout: "gho_t0ken\n" };
    if (first === "auth") return { code: signedIn ? 0 : 1, stdout: "" };
    if (first === "repo") return { code: 0, stdout: "acme/app\n" };
    if (rest[0] === "user")
      return userReadable
        ? { code: 0, stdout: JSON.stringify({ id: 42, login: "ada" }) }
        : { code: 1, stdout: '{"message":"Bad credentials"}' };
    const put = rest[0] === "-X";
    const path = put ? rest[2] : rest[0];
    const name = path?.match(/environments\/(.+)$/)?.[1];
    if (!name) return { code: 1, stdout: "" };
    if (!put) {
      const found = envs.get(name);
      if (found === "unreadable")
        return { code: 1, stdout: '{"message":"Server Error"}' };
      return found
        ? { code: 0, stdout: JSON.stringify(found) }
        : { code: 1, stdout: '{"message":"Not Found"}' };
    }
    if (args.some((arg) => arg.startsWith("reviewers")) && refuseReviewers)
      return { code: 1, stdout: '{"message":"Validation Failed"}' };
    envs.set(name, {});
    return { code: 0, stdout: "{}" };
  });
  const calls = () => capture.mock.calls.map(([, args]) => args.join(" "));
  return { capture, calls, stored };
}

interface FakeCloudflare {
  zones?: {
    id: string;
    name: string;
    status: string;
    name_servers?: string[];
  }[];
  buckets?: string[];
  bootstrapPermissions?: string[];
  r2Enabled?: boolean;
  groups?: string[];
  existingTokens?: string[];
}

const groupNames = [
  "Account API Tokens Read",
  "Account API Tokens Write",
  "Billing Read",
  "DNS Write",
  "Workers Containers Write",
  "Workers R2 Storage Bucket Item Write",
  "Workers R2 Storage Write",
  "Workers Routes Write",
  "Workers Scripts Write",
  "Zone Write",
];

function fakeCloudflare({
  zones = [],
  buckets = [],
  bootstrapPermissions = ["Account API Tokens Write"],
  r2Enabled = true,
  groups = groupNames,
  existingTokens = [],
}: FakeCloudflare = {}) {
  const tokens = new Map<string, { id: string; name: string; value: string }>([
    ["boot", { id: "boot", name: "bootstrap", value: "BOOTSTRAP" }],
    ...existingTokens.map(
      (name, index) =>
        [
          `old${index}`,
          { id: `old${index}`, name, value: `old-${index}` },
        ] as const,
    ),
  ]);
  let issued = 0;
  const requests: {
    method: string;
    path: string;
    token: string;
    body?: unknown;
  }[] = [];
  const json = (result: unknown, success = true, status = 200) =>
    Response.json({ success, result, errors: [] }, { status });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "") + url.search;
    const method = init?.method ?? "GET";
    const token =
      new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ??
      "";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, token, ...(body ? { body } : {}) });
    const caller = [...tokens.values()].find((t) => t.value === token);
    if (!caller) return json(null, false, 401);
    const accounts = "/accounts/acc123";
    if (path === `${accounts}/tokens/verify`)
      return json({ id: caller.id, status: "active" });
    if (path === `${accounts}/tokens/permission_groups`)
      return json(groups.map((name) => ({ id: `id-${name}`, name })));
    if (path === `${accounts}/tokens/boot` && method === "GET")
      return json({
        name: "bootstrap",
        policies: [
          {
            effect: "allow",
            resources: { "com.cloudflare.api.account.acc123": "*" },
            permission_groups: bootstrapPermissions.map((name) => ({ name })),
          },
        ],
      });
    if (path.startsWith(`${accounts}/tokens?`)) {
      const page = Number(url.searchParams.get("page") ?? 1);
      const all = [...tokens.values()].map(({ id, name }) => ({ id, name }));
      return json(all.slice((page - 1) * 50, page * 50));
    }
    if (path === `${accounts}/tokens` && method === "POST") {
      issued += 1;
      const id = `t${issued}`;
      tokens.set(id, { id, name: body.name, value: `value-${id}` });
      return json({ id, value: `value-${id}` });
    }
    if (path.startsWith(`${accounts}/tokens/`) && method === "DELETE") {
      tokens.delete(path.split("/").pop() ?? "");
      return json(null);
    }
    if (path.startsWith("/zones?")) {
      const name = url.searchParams.get("name");
      return json(zones.filter((zone) => zone.name === name));
    }
    if (path === "/zones" && method === "POST") {
      const zone = {
        id: "zone-new",
        name: body.name,
        status: "pending",
        name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      };
      zones.push(zone);
      return json(zone);
    }
    if (path.startsWith(`${accounts}/r2/buckets`)) {
      if (!r2Enabled)
        return Response.json(
          {
            success: false,
            result: null,
            errors: [{ code: 10042, message: "enable R2" }],
          },
          { status: 403 },
        );
      if (method === "POST") {
        buckets.push(body.name);
        return json({ name: body.name });
      }
      const name = path.split("/").pop() ?? "";
      return buckets.includes(name) ? json({ name }) : json(null, false, 404);
    }
    throw new Error(`unexpected Cloudflare request: ${method} ${path}`);
  });
  const live = () => [...tokens.values()].map((t) => t.name);
  const created = (name: string) =>
    requests.find(
      (r) =>
        r.method === "POST" &&
        r.path.endsWith("/tokens") &&
        (r.body as { name: string }).name === name,
    );
  return { fetch, requests, live, created };
}

const ask = async (question: string) =>
  question.startsWith("Cloudflare account ID") ? "acc123" : "";
const askSecret = async (question: string) =>
  question.startsWith("Cloudflare bootstrap token")
    ? "BOOTSTRAP"
    : `value of ${question}\n`;
const cloudflareKept = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "TURBO_VIBE_STATE_BUCKET",
];
const withDatabase = `${project}  db:
    kind: database
    target: supabase
    organization: acme
    region: eu-central-1
`;

function setup(
  argv: string[],
  gh: ReturnType<typeof fakeGh>,
  withAsk = true,
  cloudflare = fakeCloudflare(),
  config = project,
) {
  return run(
    ["setup", ...argv],
    { "turbo-vibe.yaml": config },
    {},
    undefined,
    cloudflare.fetch,
    { capture: gh.capture, ...(withAsk ? { ask, askSecret } : {}) },
  );
}

describe("setup", () => {
  it("refuses without a terminal, before calling gh", async () => {
    const gh = fakeGh();
    const result = await setup([], gh, false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("needs a terminal");
    expect(gh.capture).not.toHaveBeenCalled();
  });

  it("names the install command when gh is missing", async () => {
    const gh = fakeGh({ installed: false });
    const result = await setup([], gh);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("https://cli.github.com");
    expect(gh.calls().filter((call) => call.startsWith("api"))).toEqual([]);
  });

  it("names gh auth login when gh is signed out", async () => {
    const gh = fakeGh({ signedIn: false });
    const result = await setup([], gh);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("gh auth login");
    expect(gh.calls().filter((call) => call.startsWith("api"))).toEqual([]);
  });

  it("refuses an invalid config before calling gh", async () => {
    const gh = fakeGh();
    const result = await run(
      ["setup"],
      { "turbo-vibe.yaml": "version: 1\n" },
      {},
      undefined,
      fakeCloudflare().fetch,
      { capture: gh.capture, ask, askSecret },
    );
    expect(result.code).toBe(1);
    expect(gh.capture).not.toHaveBeenCalled();
  });

  it("creates only the missing environments and adds the signed-in user as production's reviewer", async () => {
    const gh = fakeGh({ environments: { staging: {} } });
    const result = await setup([], gh);
    expect(result.code).toBe(0);
    const puts = gh.calls().filter((call) => call.includes("-X PUT"));
    expect(puts).toEqual([
      "api -X PUT repos/acme/app/environments/production",
      "api -X PUT repos/acme/app/environments/production -f reviewers[][type]=User -F reviewers[][id]=42",
    ]);
    expect(result.stdout).toContain("environment staging exists");
    expect(result.stdout).toContain("production now requires a review by ada");
  });

  it("keeps an existing reviewer rule, and sends the other settings back unchanged when it adds one", async () => {
    const policy = { protected_branches: true, custom_branch_policies: false };
    const reviewed = fakeGh({
      environments: {
        staging: {},
        production: { protection_rules: [{ type: "required_reviewers" }] },
      },
    });
    expect((await setup([], reviewed)).code).toBe(0);
    expect(reviewed.calls().some((call) => call.includes("-X PUT"))).toBe(
      false,
    );

    const restricted = fakeGh({
      environments: {
        staging: {},
        production: {
          deployment_branch_policy: policy,
          can_admins_bypass: false,
          protection_rules: [{ type: "wait_timer", wait_timer: 30 }],
        },
      },
    });
    await setup(["--env", "production"], restricted);
    expect(restricted.calls()).toContain(
      "api -X PUT repos/acme/app/environments/production -f reviewers[][type]=User -F reviewers[][id]=42 -F deployment_branch_policy[protected_branches]=true -F deployment_branch_policy[custom_branch_policies]=false -F wait_timer=30 -F can_admins_bypass=false",
    );
  });

  it("warns and continues when GitHub refuses a reviewer", async () => {
    const gh = fakeGh({ refuseReviewers: true });
    const result = await setup([], gh);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("typed build ID");
  });

  it("stops without a PUT when an environment cannot be read", async () => {
    const gh = fakeGh({ environments: { production: "unreadable" } });
    const result = await setup(["--env", "production"], gh);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "cannot read the GitHub environment production",
    );
    expect(gh.calls().some((call) => call.includes("-X PUT"))).toBe(false);
  });

  it("says the user could not be read, rather than blaming the plan", async () => {
    const gh = fakeGh({ userReadable: false });
    const result = await setup([], gh);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("cannot read the signed-in GitHub user");
    expect(gh.calls().some((call) => call.includes("reviewers"))).toBe(false);
  });

  it("uses --repo over the checked-out repository", async () => {
    const gh = fakeGh();
    await setup(["--repo", "other/repo", "--env", "staging"], gh);
    expect(gh.calls()).toContain(
      "api -X PUT repos/other/repo/environments/staging",
    );
    expect(gh.calls().some((call) => call.startsWith("repo view"))).toBe(false);
  });

  it("asks only for the missing secrets and gives each value to gh on stdin, trimmed", async () => {
    const gh = fakeGh({ secrets: { staging: cloudflareKept } });
    const cloudflare = fakeCloudflare();
    const result = await setup(
      ["--env", "staging"],
      gh,
      true,
      cloudflare,
      withDatabase,
    );
    expect(result.code).toBe(0);
    expect(gh.stored).toEqual([
      {
        env: "staging",
        name: "SUPABASE_ACCESS_TOKEN",
        value: "value of Supabase access token (Account → Access Tokens)",
      },
    ]);
    expect(result.stdout).toContain(
      `staging: kept ${cloudflareKept.join(", ")}`,
    );
    expect(cloudflare.fetch).not.toHaveBeenCalled();
    for (const call of gh.calls()) expect(call).not.toContain("value of");
    expect(result.stdout + result.stderr).not.toContain("value of");
  });

  it("stores nothing for an empty answer", async () => {
    const gh = fakeGh({ secrets: { staging: cloudflareKept } });
    const result = await run(
      ["setup", "--env", "staging"],
      { "turbo-vibe.yaml": withDatabase },
      {},
      undefined,
      fakeCloudflare().fetch,
      { capture: gh.capture, ask, askSecret: async () => "  \n" },
    );
    expect(result.code).toBe(0);
    expect(gh.stored).toEqual([]);
    expect(result.stdout).toContain(
      "staging: SUPABASE_ACCESS_TOKEN skipped, nothing entered",
    );
  });

  it("ends with the checks, given the values entered in this run", async () => {
    let seen: Record<string, string | undefined> = {};
    checks.list = [
      async ({ io }) => {
        seen = { ...io.env };
        return [ok("supabase", "token works")];
      },
    ];
    const gh = fakeGh({ secrets: { staging: cloudflareKept } });
    const result = await setup(
      ["--env", "staging"],
      gh,
      true,
      fakeCloudflare(),
      withDatabase,
    );
    expect(result.code).toBe(0);
    expect(seen.SUPABASE_ACCESS_TOKEN).toBe(
      "value of Supabase access token (Account → Access Tokens)",
    );
    expect(seen).toMatchObject({
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_TOKEN: "gho_t0ken",
    });
    expect(result.stdout).toContain("staging is ready");
    expect(result.stdout).toContain(
      `staging: kept ${cloudflareKept.join(", ")}, verified by check in the environment's workflow`,
    );
  });

  it("exits non-zero when a check fails", async () => {
    checks.list = [
      async () => [
        fail("cloudflare", "zone is pending", "set the nameservers"),
      ],
    ];
    const result = await setup(["--env", "staging"], fakeGh());
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL  cloudflare: zone is pending");
  });

  it("does not report a kept secret as missing, but does report one left empty", async () => {
    checks.list = [
      async ({ io }) =>
        ["CLOUDFLARE_ACCOUNT_ID", "SUPABASE_ACCESS_TOKEN"]
          .filter((name) => !io.env[name])
          .map((name) => missing("supabase", name, "set it")),
    ];
    const gh = fakeGh({ secrets: { staging: cloudflareKept } });
    const result = await run(
      ["setup", "--env", "staging"],
      { "turbo-vibe.yaml": withDatabase },
      {},
      undefined,
      fakeCloudflare().fetch,
      { capture: gh.capture, ask, askSecret: async () => "" },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("CLOUDFLARE_ACCOUNT_ID is not set");
    expect(result.stdout).toContain("SUPABASE_ACCESS_TOKEN is not set");
  });

  it("hides the shell's own values for the project's secrets from the checks", async () => {
    let seen: Record<string, string | undefined> = {};
    checks.list = [
      async ({ io }) => {
        seen = { ...io.env };
        return [];
      },
    ];
    const gh = fakeGh({ secrets: { staging: ["CLOUDFLARE_API_TOKEN"] } });
    await run(
      ["setup", "--env", "staging"],
      { "turbo-vibe.yaml": project },
      { CLOUDFLARE_API_TOKEN: "shell-token", HOME: "/home/ada" },
      undefined,
      fakeCloudflare().fetch,
      { capture: gh.capture, ask, askSecret },
    );
    expect(seen.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(seen.HOME).toBe("/home/ada");
  });

  it("drops the state check's not-set failure when every named secret is kept", async () => {
    checks.list = [stateBucket];
    const gh = fakeGh({
      secrets: {
        staging: [
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
          "CLOUDFLARE_ACCOUNT_ID",
          "TURBO_VIBE_STATE_BUCKET",
        ],
      },
    });
    const result = await setup(["--env", "staging"], gh);
    expect(result.stdout).not.toContain("not set");
    expect(result.stdout).toContain("staging is ready");
  });

  it("names only the skipped secrets when one finding names kept and skipped ones", async () => {
    checks.list = [
      async () => [
        {
          ...fail("vendors", "x", "set them"),
          message: "CLOUDFLARE_ACCOUNT_ID, SUPABASE_ACCESS_TOKEN are not set",
          unset: ["CLOUDFLARE_ACCOUNT_ID", "SUPABASE_ACCESS_TOKEN"],
        },
      ],
    ];
    const gh = fakeGh({ secrets: { staging: cloudflareKept } });
    const result = await run(
      ["setup", "--env", "staging"],
      { "turbo-vibe.yaml": withDatabase },
      {},
      undefined,
      fakeCloudflare().fetch,
      { capture: gh.capture, ask, askSecret: async () => "" },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "FAIL  vendors: SUPABASE_ACCESS_TOKEN is not set",
    );
  });
});

describe("setup on Cloudflare", () => {
  it("creates the zone and the bucket through a short-lived token, then deletes that token", async () => {
    const gh = fakeGh();
    const cloudflare = fakeCloudflare();
    const result = await setup([], gh, true, cloudflare);
    expect(result.code).toBe(0);
    const writes = cloudflare.requests.filter(
      (r) => r.method === "POST" && !r.path.endsWith("/tokens"),
    );
    expect(writes.map((r) => [r.path, r.token])).toEqual([
      ["/zones", "value-t1"],
      ["/accounts/acc123/r2/buckets", "value-t1"],
    ]);
    expect(writes[0]?.body).toMatchObject({
      name: "example.com",
      account: { id: "acc123" },
    });
    expect(cloudflare.live()).not.toContain("turbo-vibe-acme-setup");
    expect(result.stdout).toContain(
      "set the nameservers of example.com to ada.ns.cloudflare.com and bob.ns.cloudflare.com",
    );
    for (const env of ["staging", "production"])
      expect(gh.stored.filter((secret) => secret.env === env)).toEqual(
        expect.arrayContaining([
          { env, name: "CLOUDFLARE_ACCOUNT_ID", value: "acc123" },
          { env, name: "CLOUDFLARE_ZONE_ID", value: "zone-new" },
          {
            env,
            name: "TURBO_VIBE_STATE_BUCKET",
            value: "acme-turbo-vibe-state",
          },
        ]),
      );
  });

  it("repeats the nameservers for an existing zone that is still pending", async () => {
    const cloudflare = fakeCloudflare({
      zones: [
        {
          id: "zone-1",
          name: "example.com",
          status: "pending",
          name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
        },
      ],
    });
    const result = await setup(
      ["--env", "staging"],
      fakeGh(),
      true,
      cloudflare,
    );
    expect(result.stdout).toContain(
      "set the nameservers of example.com to ada.ns.cloudflare.com and bob.ns.cloudflare.com",
    );
  });

  it("reuses an existing zone and bucket", async () => {
    const cloudflare = fakeCloudflare({
      zones: [{ id: "zone-1", name: "example.com", status: "active" }],
      buckets: ["acme-turbo-vibe-state"],
    });
    const gh = fakeGh();
    expect((await setup(["--env", "staging"], gh, true, cloudflare)).code).toBe(
      0,
    );
    expect(
      cloudflare.requests
        .filter((r) => r.method === "POST" && !r.path.endsWith("/tokens"))
        .map((r) => r.path),
    ).toEqual([]);
    expect(gh.stored).toContainEqual({
      env: "staging",
      name: "CLOUDFLARE_ZONE_ID",
      value: "zone-1",
    });
  });

  it("stops before creating anything when the bootstrap token cannot create tokens", async () => {
    const cloudflare = fakeCloudflare({ bootstrapPermissions: ["Zone Read"] });
    const gh = fakeGh();
    const result = await setup([], gh, true, cloudflare);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("lacks Account API Tokens Write");
    expect(cloudflare.requests.some((r) => r.method === "POST")).toBe(false);
    expect(gh.stored).toEqual([]);
  });

  it("tells the person to enable R2 when Cloudflare refuses the bucket", async () => {
    const cloudflare = fakeCloudflare({ r2Enabled: false });
    const result = await setup([], fakeGh(), true, cloudflare);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("R2 is not enabled on this account");
    expect(cloudflare.live()).toEqual(["bootstrap"]);
  });

  it("asks for no bootstrap token when every environment has the Cloudflare secrets", async () => {
    const cloudflare = fakeCloudflare();
    const gh = fakeGh({
      secrets: { staging: cloudflareKept, production: cloudflareKept },
    });
    expect((await setup([], gh, true, cloudflare)).code).toBe(0);
    expect(cloudflare.fetch).not.toHaveBeenCalled();
  });

  it("gives each environment its own CI token with exactly what check needs, and R2 keys derived from its own R2 token", async () => {
    const gh = fakeGh();
    const cloudflare = fakeCloudflare();
    expect((await setup([], gh, true, cloudflare)).code).toBe(0);
    const ci = cloudflare.created("turbo-vibe-acme-staging");
    if (!ci) throw new Error("no staging CI token was created");
    const policies = (
      ci.body as {
        policies: { permission_groups: { id: string }[] }[];
      }
    ).policies.map((policy) => ({
      ...policy,
      permission_groups: policy.permission_groups.map((group) => ({
        name: group.id.replace(/^id-/, ""),
      })),
    }));
    const parsed = parseConfig(project);
    if (!parsed.ok) throw new Error("fixture does not parse");
    const needed = [
      ...requiredPermissions({ config: parsed.config }),
      "Account API Tokens Read",
      "Billing Read",
    ];
    for (const permission of needed)
      expect(
        granted(policies, permission, { account: "acc123", zone: "zone-new" }),
      ).toBe(true);
    expect(policies.flatMap((p) => p.permission_groups).length).toBe(
      needed.length,
    );

    const r2 = cloudflare.created("turbo-vibe-acme-staging-r2");
    expect(r2?.body).toMatchObject({
      policies: [
        {
          resources: {
            "com.cloudflare.edge.r2.bucket.acc123_default_acme-turbo-vibe-state":
              "*",
          },
          permission_groups: [
            { id: "id-Workers R2 Storage Bucket Item Write" },
          ],
        },
      ],
    });
    const staging = Object.fromEntries(
      gh.stored
        .filter((secret) => secret.env === "staging")
        .map((secret) => [secret.name, secret.value]),
    );
    expect(staging).toMatchObject({
      CLOUDFLARE_API_TOKEN: "value-t2",
      AWS_ACCESS_KEY_ID: "t3",
      // SHA-256 of the R2 token's value, "value-t3".
      AWS_SECRET_ACCESS_KEY:
        "0d1ae4afc983b09f1315916493ef7e16e69daddc9c65d78377065535ed06030e",
    });
    const production = gh.stored.find(
      (secret) =>
        secret.env === "production" && secret.name === "CLOUDFLARE_API_TOKEN",
    );
    expect(production?.value).toBe("value-t4");
  });

  it("stops and names a permission group Cloudflare does not have, before creating anything", async () => {
    const cloudflare = fakeCloudflare({
      groups: groupNames.filter((name) => name !== "Workers Containers Write"),
    });
    const result = await setup([], fakeGh(), true, cloudflare);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Cloudflare has no permission group named Workers Containers Write",
    );
    expect(cloudflare.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("keeps a token whose secret exists, and replaces one whose secret is gone", async () => {
    const cloudflare = fakeCloudflare({
      existingTokens: ["turbo-vibe-acme-staging", "turbo-vibe-acme-production"],
    });
    const gh = fakeGh({
      secrets: {
        staging: cloudflareKept.filter(
          (name) => name !== "CLOUDFLARE_API_TOKEN",
        ),
        production: cloudflareKept.filter(
          (name) => name !== "CLOUDFLARE_ZONE_ID",
        ),
      },
    });
    expect((await setup([], gh, true, cloudflare)).code).toBe(0);
    expect(cloudflare.requests).toContainEqual(
      expect.objectContaining({
        method: "DELETE",
        path: "/accounts/acc123/tokens/old0",
      }),
    );
    expect(cloudflare.live()).toContain("turbo-vibe-acme-staging");
    expect(cloudflare.created("turbo-vibe-acme-staging")).toBeDefined();
    expect(cloudflare.created("turbo-vibe-acme-production")).toBeUndefined();
    expect(
      gh.stored
        .filter((secret) => secret.env === "production")
        .map((s) => s.name),
    ).toEqual(["CLOUDFLARE_ZONE_ID"]);
  });

  it("replaces both R2 keys when one of them is gone", async () => {
    const gh = fakeGh({
      secrets: {
        staging: cloudflareKept.filter(
          (name) => name !== "AWS_SECRET_ACCESS_KEY",
        ),
      },
    });
    const cloudflare = fakeCloudflare();
    expect((await setup(["--env", "staging"], gh, true, cloudflare)).code).toBe(
      0,
    );
    expect(gh.stored.map((secret) => secret.name)).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]);
    expect(cloudflare.created("turbo-vibe-acme-staging")).toBeUndefined();
  });

  it("deletes the bootstrap token only when the person says yes", async () => {
    const kept = fakeCloudflare();
    const declined = await setup(["--env", "staging"], fakeGh(), true, kept);
    expect(kept.live()).toContain("bootstrap");
    expect(declined.stdout).toContain(
      "the bootstrap token bootstrap still exists; delete it at https://dash.cloudflare.com/acc123/api-tokens",
    );

    const removed = fakeCloudflare();
    const result = await run(
      ["setup", "--env", "staging"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      removed.fetch,
      {
        capture: fakeGh().capture,
        ask: async (question: string) =>
          question.startsWith("Delete the Cloudflare bootstrap token")
            ? "y"
            : ask(question),
        askSecret,
      },
    );
    expect(removed.live()).not.toContain("bootstrap");
    expect(result.stdout).toContain(
      "cloudflare: bootstrap token bootstrap deleted",
    );
  });

  it("deletes every old token of that name, also beyond the first page", async () => {
    const others = Array.from({ length: 49 }, (_, index) => `other-${index}`);
    const cloudflare = fakeCloudflare({
      existingTokens: [
        "turbo-vibe-acme-staging",
        ...others,
        "turbo-vibe-acme-staging",
      ],
    });
    const gh = fakeGh({
      secrets: {
        staging: cloudflareKept.filter(
          (name) => name !== "CLOUDFLARE_API_TOKEN",
        ),
      },
    });
    expect((await setup(["--env", "staging"], gh, true, cloudflare)).code).toBe(
      0,
    );
    expect(
      cloudflare.live().filter((name) => name === "turbo-vibe-acme-staging"),
    ).toHaveLength(1);
  });

  it("keeps the bootstrap token when a secret cannot be stored", async () => {
    const gh = fakeGh();
    const failing = vi.fn<Capturer>(async (command, args, options) =>
      args[0] === "secret" && args[1] === "set"
        ? { code: 1, stdout: "" }
        : gh.capture(command, args, options),
    );
    const cloudflare = fakeCloudflare();
    const ask = vi.fn(async (question: string) =>
      question.startsWith("Cloudflare account ID") ? "acc123" : "y",
    );
    const result = await run(
      ["setup", "--env", "staging"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      cloudflare.fetch,
      { capture: failing, ask, askSecret },
    );
    expect(result.code).toBe(1);
    expect(cloudflare.live()).toContain("bootstrap");
    expect(
      ask.mock.calls.some(([question]) => question.startsWith("Delete")),
    ).toBe(false);
  });
});

function vendors(
  cloudflare: ReturnType<typeof fakeCloudflare>,
  {
    organizations = [{ id: "acme-org", name: "Acme" }],
    teams = [{ id: "team_1", name: "Acme" }],
  }: {
    organizations?: { id: string; name: string }[];
    teams?: { id: string; name: string }[];
  } = {},
) {
  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url === "https://api.supabase.com/v1/organizations")
      return Response.json(organizations);
    if (url === "https://api.vercel.com/v2/teams")
      return Response.json({ teams });
    return cloudflare.fetch(input, init);
  });
}

const noOrganization = withDatabase.replace("    organization: acme\n", "");
const onVercel = `version: 1
project: acme
domain: acme.example.com
services:
  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile }
  web:
    kind: frontend
    target: vercel-static
    build: { command: "pnpm build", output: dist }
`;
const withSignIn = `${project}  auth:
    kind: identity
    target: workos
`;

function setupWith(
  config: string,
  fetch: typeof globalThis.fetch,
  gh: ReturnType<typeof fakeGh>,
  overrides: Partial<Io> = {},
) {
  return run(["setup"], { "turbo-vibe.yaml": config }, {}, undefined, fetch, {
    capture: gh.capture,
    ask,
    askSecret,
    ...overrides,
  });
}

const storedValue = (
  gh: ReturnType<typeof fakeGh>,
  env: string,
  name: string,
) => gh.stored.find((s) => s.env === env && s.name === name)?.value;

describe("setup with vendor tokens", () => {
  const allKept = { staging: cloudflareKept, production: cloudflareKept };

  it("stores the only Supabase organization the token sees, without a question", async () => {
    const gh = fakeGh({ secrets: allKept });
    const asked = vi.fn(ask);
    const fetch = vendors(fakeCloudflare());
    const result = await setupWith(noOrganization, fetch, gh, { ask: asked });
    expect(result.code).toBe(0);
    expect(storedValue(gh, "staging", "SUPABASE_ORGANIZATION")).toBe(
      "acme-org",
    );
    expect(storedValue(gh, "production", "SUPABASE_ORGANIZATION")).toBe(
      "acme-org",
    );
    expect(
      asked.mock.calls.some(([q]) => q.startsWith("Supabase organization")),
    ).toBe(false);
  });

  it("asks which organization when the token sees two", async () => {
    const gh = fakeGh({ secrets: allKept });
    const fetch = vendors(fakeCloudflare(), {
      organizations: [
        { id: "first", name: "First" },
        { id: "second", name: "Second" },
      ],
    });
    const result = await setupWith(noOrganization, fetch, gh, {
      ask: async (q: string) =>
        q.startsWith("Supabase organization") ? "2" : ask(q),
    });
    expect(result.code).toBe(0);
    expect(storedValue(gh, "staging", "SUPABASE_ORGANIZATION")).toBe("second");
  });

  it("stores no organization when the config names one", async () => {
    const gh = fakeGh({ secrets: allKept });
    const fetch = vendors(fakeCloudflare());
    await setupWith(withDatabase, fetch, gh);
    expect(gh.stored.map((s) => s.name)).not.toContain("SUPABASE_ORGANIZATION");
    expect(
      fetch.mock.calls.some(([url]) => String(url).includes("supabase")),
    ).toBe(false);
  });

  it("stores the only Vercel team the token sees, without a question", async () => {
    const gh = fakeGh({ secrets: allKept });
    const result = await setupWith(onVercel, vendors(fakeCloudflare()), gh);
    expect(result.code).toBe(0);
    expect(storedValue(gh, "staging", "VERCEL_TEAM_ID")).toBe("team_1");
    expect(storedValue(gh, "production", "VERCEL_API_TOKEN")).toBe(
      "value of Vercel access token (Account Settings → Tokens)",
    );
  });

  it("refuses the other environment's WorkOS key and asks again", async () => {
    const gh = fakeGh({ secrets: allKept });
    const answers: Record<string, string[]> = {
      staging: ["sk_live_wrong", "sk_test_right"],
      production: ["sk_test_wrong", "sk_live_right"],
    };
    const result = await setupWith(withSignIn, vendors(fakeCloudflare()), gh, {
      askSecret: async (q: string) => {
        const env = q.split(" ")[0] ?? "";
        if (q.includes("WORKOS_API_KEY")) return answers[env]?.shift() ?? "";
        return `value of ${q}`;
      },
    });
    expect(result.code).toBe(0);
    expect(storedValue(gh, "staging", "WORKOS_API_KEY")).toBe("sk_test_right");
    expect(storedValue(gh, "production", "WORKOS_API_KEY")).toBe(
      "sk_live_right",
    );
    expect(result.stdout).toContain(
      "staging needs the WorkOS staging environment's key, which starts with sk_test_",
    );
    expect(result.stdout).toContain(
      "production needs the WorkOS production environment's key, which starts with sk_live_",
    );
  });

  it("leaves the organization to its own prompt when the person chooses none of two", async () => {
    const gh = fakeGh({ secrets: allKept });
    const fetch = vendors(fakeCloudflare(), {
      organizations: [
        { id: "first", name: "First" },
        { id: "second", name: "Second" },
      ],
    });
    const result = await setupWith(noOrganization, fetch, gh);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("sees no organization");
    expect(storedValue(gh, "staging", "SUPABASE_ORGANIZATION")).toBe(
      "value of staging SUPABASE_ORGANIZATION",
    );
  });
});
