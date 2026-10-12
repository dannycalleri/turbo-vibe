import { beforeEach, describe, expect, it, vi } from "vitest";
import { stateBucket } from "../src/checks/state.js";
import type { Check } from "../src/checks/types.js";
import { fail, missing, ok } from "../src/checks/types.js";
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
}

const groupNames = [
  "Account API Tokens Write",
  "Zone Write",
  "Workers R2 Storage Write",
];

function fakeCloudflare({
  zones = [],
  buckets = [],
  bootstrapPermissions = ["Account API Tokens Write"],
  r2Enabled = true,
}: FakeCloudflare = {}) {
  const tokens = new Map<string, { id: string; name: string; value: string }>([
    ["boot", { id: "boot", name: "bootstrap", value: "BOOTSTRAP" }],
  ]);
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
      return json(groupNames.map((name) => ({ id: `id-${name}`, name })));
    if (path === `${accounts}/tokens/boot`)
      return json({
        policies: [
          {
            effect: "allow",
            resources: { "com.cloudflare.api.account.acc123": "*" },
            permission_groups: bootstrapPermissions.map((name) => ({ name })),
          },
        ],
      });
    if (path.startsWith(`${accounts}/tokens?`))
      return json([...tokens.values()].map(({ id, name }) => ({ id, name })));
    if (path === `${accounts}/tokens` && method === "POST") {
      const id = `t${tokens.size}`;
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
  return { fetch, requests, live };
}

const ask = async (question: string) =>
  question.startsWith("Cloudflare account ID") ? "acc123" : "";
const askSecret = async (question: string) =>
  question.startsWith("Cloudflare bootstrap token")
    ? "BOOTSTRAP"
    : `value of ${question}\n`;
const cloudflareKept = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "TURBO_VIBE_STATE_BUCKET",
];

function setup(
  argv: string[],
  gh: ReturnType<typeof fakeGh>,
  withAsk = true,
  cloudflare = fakeCloudflare(),
) {
  return run(
    ["setup", ...argv],
    { "turbo-vibe.yaml": project },
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
    const gh = fakeGh({
      secrets: {
        staging: ["CLOUDFLARE_ACCOUNT_ID", "TURBO_VIBE_STATE_BUCKET"],
      },
    });
    const result = await setup(["--env", "staging"], gh);
    expect(result.code).toBe(0);
    expect(gh.stored.map((secret) => secret.name)).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ZONE_ID",
    ]);
    expect(gh.stored[2]).toEqual({
      env: "staging",
      name: "CLOUDFLARE_API_TOKEN",
      value: "value of staging CLOUDFLARE_API_TOKEN",
    });
    expect(result.stdout).toContain(
      "staging: kept CLOUDFLARE_ACCOUNT_ID, TURBO_VIBE_STATE_BUCKET",
    );
    for (const call of gh.calls()) expect(call).not.toContain("value of");
    expect(result.stdout + result.stderr).not.toContain("value of");
  });

  it("stores nothing for an empty answer", async () => {
    const gh = fakeGh({ secrets: { staging: cloudflareKept } });
    const result = await run(
      ["setup", "--env", "staging"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      fakeCloudflare().fetch,
      { capture: gh.capture, ask, askSecret: async () => "  \n" },
    );
    expect(result.code).toBe(0);
    expect(gh.stored).toEqual([]);
    expect(result.stdout).toContain(
      "staging: CLOUDFLARE_API_TOKEN skipped, nothing entered",
    );
  });

  it("ends with the checks, given the values entered in this run", async () => {
    let seen: Record<string, string | undefined> = {};
    checks.list = [
      async ({ io }) => {
        seen = { ...io.env };
        return [ok("cloudflare", "token works")];
      },
    ];
    const gh = fakeGh({ secrets: { staging: ["CLOUDFLARE_ACCOUNT_ID"] } });
    const result = await setup(["--env", "staging"], gh);
    expect(result.code).toBe(0);
    expect(seen.CLOUDFLARE_API_TOKEN).toBe(
      "value of staging CLOUDFLARE_API_TOKEN",
    );
    expect(seen).toMatchObject({
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_TOKEN: "gho_t0ken",
    });
    expect(result.stdout).toContain("staging is ready");
    expect(result.stdout).toContain(
      "staging: kept CLOUDFLARE_ACCOUNT_ID, verified by check in the environment's workflow",
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
        ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]
          .filter((name) => !io.env[name])
          .map((name) => missing("cloudflare", name, "set it")),
    ];
    const gh = fakeGh({ secrets: { staging: cloudflareKept } });
    const result = await run(
      ["setup", "--env", "staging"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      fakeCloudflare().fetch,
      { capture: gh.capture, ask, askSecret: async () => "" },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("CLOUDFLARE_ACCOUNT_ID is not set");
    expect(result.stdout).toContain("CLOUDFLARE_API_TOKEN is not set");
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

  it("names only the skipped secrets when the state check finds kept and skipped ones", async () => {
    checks.list = [stateBucket];
    const gh = fakeGh({
      secrets: {
        staging: [...cloudflareKept, "AWS_ACCESS_KEY_ID"],
      },
    });
    const result = await run(
      ["setup", "--env", "staging"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      fakeCloudflare().fetch,
      { capture: gh.capture, ask, askSecret: async () => "" },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "FAIL  state bucket: AWS_SECRET_ACCESS_KEY is not set",
    );
  });
});

describe("setup on Cloudflare", () => {
  it("creates the zone and the bucket through a short-lived token, then deletes that token", async () => {
    const gh = fakeGh();
    const cloudflare = fakeCloudflare();
    const result = await setup([], gh, true, cloudflare);
    expect(result.code).toBe(0);
    const writes = cloudflare.requests.filter((r) => r.method === "POST");
    expect(writes.map((r) => [r.path, r.token])).toEqual([
      ["/accounts/acc123/tokens", "BOOTSTRAP"],
      ["/zones", "value-t1"],
      ["/accounts/acc123/r2/buckets", "value-t1"],
    ]);
    expect(writes[1]?.body).toMatchObject({
      name: "example.com",
      account: { id: "acc123" },
    });
    expect(cloudflare.live()).toEqual(["bootstrap"]);
    expect(result.stdout).toContain(
      "set the nameservers of example.com to ada.ns.cloudflare.com and bob.ns.cloudflare.com",
    );
    for (const env of ["staging", "production"])
      expect(
        gh.stored.filter(
          (secret) =>
            secret.env === env &&
            secret.name !== "CLOUDFLARE_API_TOKEN" &&
            !secret.name.startsWith("AWS"),
        ),
      ).toEqual([
        { env, name: "CLOUDFLARE_ACCOUNT_ID", value: "acc123" },
        { env, name: "CLOUDFLARE_ZONE_ID", value: "zone-new" },
        {
          env,
          name: "TURBO_VIBE_STATE_BUCKET",
          value: "acme-turbo-vibe-state",
        },
      ]);
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
      cloudflare.requests.filter((r) => r.method === "POST").map((r) => r.path),
    ).toEqual(["/accounts/acc123/tokens"]);
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
});
