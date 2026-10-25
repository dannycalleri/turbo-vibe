import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  granted,
  requiredPermissions,
  zoneScoped,
} from "../src/checks/cloudflare.js";
import { stateBucket } from "../src/checks/state.js";
import type { Check } from "../src/checks/types.js";
import { fail, missing, ok } from "../src/checks/types.js";
import { parseConfig } from "../src/config/load.js";
import type { Io } from "../src/io.js";
import type { Capturer, Runner } from "../src/run.js";
import {
  bootstrapTokenUrl,
  cloudflareStep,
  stepLines,
  supabaseStep,
} from "../src/setup/steps.js";
import { fakePrompts, project, run } from "./harness.js";

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
  variables?: Record<string, string[]>;
  rules?: Record<string, string[]>;
}

function fakeGh({
  signedIn = true,
  installed = true,
  environments = {},
  refuseReviewers = false,
  userReadable = true,
  secrets = {},
  variables = {},
  rules = {},
}: FakeGitHub = {}) {
  const envs = new Map(Object.entries(environments));
  const branchRules = new Map<string, string[]>(Object.entries(rules));
  const stored: { env: string; name: string; value: string | undefined }[] = [];
  const capture = vi.fn<Capturer>(async (command, args, options) => {
    const failed = (stdout: string, error: string) => ({
      code: 1,
      stdout,
      ...(options.quiet ? { stderr: `gh: ${error}\n` } : {}),
    });
    if (command !== "gh") return { code: 0, stdout: "{}" };
    if (!installed) throw new Error("spawn gh ENOENT");
    const [first, ...rest] = args;
    if (first === "secret" || first === "variable") {
      const env = args.includes("--env")
        ? (args[args.indexOf("--env") + 1] ?? "")
        : "repository";
      const listed = first === "secret" ? secrets : variables;
      if (rest[0] === "list")
        return {
          code: 0,
          stdout: JSON.stringify((listed[env] ?? []).map((name) => ({ name }))),
        };
      stored.push({
        env,
        name: first === "variable" ? `variable ${rest[1]}` : (rest[1] ?? ""),
        value: options.input,
      });
      return { code: 0, stdout: "" };
    }
    if (first === "auth" && rest[0] === "token")
      return { code: 0, stdout: "gho_t0ken\n" };
    if (first === "auth")
      return signedIn
        ? { code: 0, stdout: "" }
        : failed("", "You are not logged into any GitHub hosts.");
    if (first === "repo") return { code: 0, stdout: "acme/app\n" };
    if (rest[0] === "user")
      return userReadable
        ? { code: 0, stdout: JSON.stringify({ id: 42, login: "ada" }) }
        : { code: 1, stdout: '{"message":"Bad credentials"}' };
    const method = rest[0] === "-X" ? rest[1] : "GET";
    const put = method === "PUT";
    const path = rest[0] === "-X" ? rest[2] : rest[0];
    const rule = path?.match(
      /environments\/([^/]+)\/deployment-branch-policies$/,
    )?.[1];
    if (rule) {
      if (method === "POST") {
        branchRules.set(rule, [...(branchRules.get(rule) ?? []), "main"]);
        return { code: 0, stdout: "{}" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          branch_policies: (branchRules.get(rule) ?? []).map((name) => ({
            name,
          })),
        }),
      };
    }
    const name = path?.match(/environments\/([^/]+)$/)?.[1];
    if (!name) return { code: 1, stdout: "" };
    if (!put) {
      const found = envs.get(name);
      if (found === "unreadable")
        return failed('{"message":"Server Error"}', "Server Error (HTTP 500)");
      return found
        ? { code: 0, stdout: JSON.stringify(found) }
        : failed('{"message":"Not Found"}', "Not Found (HTTP 404)");
    }
    if (args.some((arg) => arg.startsWith("reviewers")) && refuseReviewers)
      return failed(
        '{"message":"Validation Failed"}',
        "Failed to create the environment protection rule. (HTTP 422)",
      );
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
  accounts?: { id: string; name: string }[];
  refusedBuckets?: number;
  unpaidReads?: number;
  billingReadable?: boolean;
  groups?: string[];
  existingTokens?: string[];
}

const groupNames = [
  "Access: Apps and Policies Write",
  "Account API Tokens Read",
  "Account API Tokens Write",
  "Billing Read",
  "DNS Write",
  "Workers Containers Write",
  "Workers R2 Storage Bucket Item Read",
  "Workers R2 Storage Bucket Item Write",
  "Workers R2 Storage Write",
  "Workers Routes Write",
  "Workers Scripts Write",
  "Zone Settings Write",
  "Zone Write",
];

function fakeCloudflare({
  zones = [],
  buckets = [],
  bootstrapPermissions = ["Account API Tokens Write"],
  accounts: visible = [{ id: "acc123", name: "Acme" }],
  refusedBuckets = 0,
  unpaidReads = 0,
  billingReadable = true,
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
    if (url.host === "api.supabase.com")
      return Response.json([{ id: "acme", name: "Acme" }]);
    if (url.host === "api.vercel.com")
      return Response.json({ teams: [{ id: "team_1", name: "Acme" }] });
    if (url.host === "api.workos.com") return Response.json({ data: [] });
    const path = url.pathname.replace("/client/v4", "") + url.search;
    const method = init?.method ?? "GET";
    const token =
      new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ??
      "";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, token, ...(body ? { body } : {}) });
    const caller = [...tokens.values()].find((t) => t.value === token);
    if (!caller) return json(null, false, 401);
    if (path === "/accounts") return json(visible);
    const accounts = "/accounts/acc123";
    if (path === `${accounts}/tokens/verify`)
      return json({ id: caller.id, status: "active" });
    if (path === `${accounts}/tokens/permission_groups`)
      return json([
        ...groups.map((name) => ({
          id: `id-${name}`,
          name,
          scopes: [
            zoneScoped.has(name)
              ? "com.cloudflare.api.account.zone"
              : "com.cloudflare.api.account",
          ],
        })),
        // Cloudflare lists this name twice, once per scope; the account group comes last here.
        {
          id: "id-account-Access: Apps and Policies Write",
          name: "Access: Apps and Policies Write",
          scopes: ["com.cloudflare.api.account"],
        },
      ]);
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
    if (path === `${accounts}/subscriptions`)
      if (!billingReadable) return json(null, false, 403);
      else
        return json(
          unpaidReads-- > 0
            ? [{ rate_plan: { id: "free", public_name: "Workers Free" } }]
            : [
                {
                  rate_plan: {
                    id: "workers_paid",
                    public_name: "Workers Paid",
                  },
                },
              ],
        );
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
      if (method === "POST" && refusedBuckets-- > 0)
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

const ask = async (_question: string) => "";
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

  it("creates only the missing environments, limits staging and production to main, and adds the signed-in user as production's reviewer", async () => {
    const gh = fakeGh({ environments: { staging: {} } });
    const result = await setup([], gh);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("github: environment production created");
    expect(result.stderr).not.toContain("HTTP 404");
    const secretSets = gh.capture.mock.calls.filter(
      ([, args]) => args[0] === "secret" && args[1] === "set",
    );
    expect(secretSets.length).toBeGreaterThan(0);
    for (const [, , options] of secretSets)
      expect(options.quiet).toBeUndefined();
    const writes = gh
      .calls()
      .filter((call) => call.includes("-X PUT") || call.includes("-X POST"));
    expect(writes).toEqual([
      "api -X PUT repos/acme/app/environments/staging -F deployment_branch_policy[protected_branches]=false -F deployment_branch_policy[custom_branch_policies]=true",
      "api -X POST repos/acme/app/environments/staging/deployment-branch-policies -f name=main -f type=branch",
      "api -X PUT repos/acme/app/environments/production",
      "api -X PUT repos/acme/app/environments/production -f reviewers[][type]=User -F reviewers[][id]=42 -F deployment_branch_policy[protected_branches]=false -F deployment_branch_policy[custom_branch_policies]=true",
      "api -X POST repos/acme/app/environments/production/deployment-branch-policies -f name=main -f type=branch",
    ]);
    expect(result.stdout).toContain("environment staging exists");
    expect(result.stdout).toContain("production now requires a review by ada");
    expect(result.stdout).toContain(
      "staging accepts deployments from main only",
    );
  });

  it("changes nothing on environments that already require a reviewer and accept only main", async () => {
    const done = {
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    };
    const gh = fakeGh({
      environments: {
        staging: done,
        production: {
          ...done,
          protection_rules: [
            {
              type: "required_reviewers",
              reviewers: [{ type: "User", reviewer: { id: 7 } }],
            },
          ],
        },
      },
      rules: { staging: ["main"], production: ["main"] },
    });
    expect((await setup([], gh)).code).toBe(0);
    expect(
      gh
        .calls()
        .some((call) => call.includes("-X PUT") || call.includes("-X POST")),
    ).toBe(false);
  });

  it("sends the existing reviewers and settings back when it limits an environment to main", async () => {
    const gh = fakeGh({
      environments: {
        production: {
          can_admins_bypass: false,
          deployment_branch_policy: {
            protected_branches: true,
            custom_branch_policies: false,
          },
          protection_rules: [
            { type: "wait_timer", wait_timer: 30 },
            {
              type: "required_reviewers",
              prevent_self_review: true,
              reviewers: [{ type: "Team", reviewer: { id: 9 } }],
            },
          ],
        },
      },
    });
    await setup(["--env", "production"], gh);
    expect(gh.calls()).toContain(
      "api -X PUT repos/acme/app/environments/production -f reviewers[][type]=Team -F reviewers[][id]=9 -F prevent_self_review=true -F deployment_branch_policy[protected_branches]=false -F deployment_branch_policy[custom_branch_policies]=true -F wait_timer=30 -F can_admins_bypass=false",
    );
  });

  it("still limits production to main when GitHub refuses a reviewer", async () => {
    const gh = fakeGh({ refuseReviewers: true });
    const result = await setup(["--env", "production"], gh);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("needs GitHub Enterprise for it");
    expect(result.stdout).toContain("typed build ID");
    expect(result.stderr).not.toContain("HTTP 422");
    expect(gh.calls()).toContain(
      "api -X PUT repos/acme/app/environments/production -F deployment_branch_policy[protected_branches]=false -F deployment_branch_policy[custom_branch_policies]=true",
    );
    expect(gh.calls()).toContain(
      "api -X POST repos/acme/app/environments/production/deployment-branch-policies -f name=main -f type=branch",
    );
    expect(result.stdout).toContain(
      "production accepts deployments from main only",
    );
  });

  it("names branch rules other than main instead of claiming main only", async () => {
    const gh = fakeGh({
      environments: {
        staging: {
          deployment_branch_policy: {
            protected_branches: false,
            custom_branch_policies: true,
          },
        },
      },
      rules: { staging: ["main", "release/*"] },
    });
    const result = await setup(["--env", "staging"], gh);
    expect(result.stdout).toContain(
      "staging also accepts deployments from release/*",
    );
    expect(result.stdout).not.toContain(
      "staging accepts deployments from main only",
    );
  });

  it("stops without a PUT when an environment cannot be read", async () => {
    const gh = fakeGh({ environments: { production: "unreadable" } });
    const result = await setup(["--env", "production"], gh);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "cannot read the GitHub environment production",
    );
    expect(result.stderr).toContain("gh: Server Error (HTTP 500)\n");
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
        value: "value of Supabase access token",
      },
    ]);
    expect(result.stdout).toContain(
      `staging: kept ${cloudflareKept.join(", ")}`,
    );
    expect(cloudflare.requests).toEqual([]);
    for (const call of gh.calls()) expect(call).not.toContain("value of");
    expect(result.stdout + result.stderr).not.toContain("value of");
  });

  it("asks for a declared secret once per environment, stores each value in its own environment, and keeps it on a re-run", async () => {
    const withSecret = project.replace(
      "    target: cloudflare-container\n",
      "    target: cloudflare-container\n    secrets: [STRIPE_SECRET_KEY]\n",
    );
    const kept = {
      staging: cloudflareKept,
      production: [...cloudflareKept, "TURBO_VIBE_BUILDS_BUCKET"],
    };
    const first = fakeGh({ secrets: kept });
    const result = await setup(
      ["--env", "staging", "production"],
      first,
      true,
      fakeCloudflare(),
      withSecret,
    );
    expect(result.code).toBe(0);
    expect(first.stored).toEqual([
      {
        env: "staging",
        name: "STRIPE_SECRET_KEY",
        value:
          "value of staging STRIPE_SECRET_KEY (declared by api: the value for staging)",
      },
      {
        env: "production",
        name: "STRIPE_SECRET_KEY",
        value:
          "value of production STRIPE_SECRET_KEY (declared by api: the value for production)",
      },
    ]);

    const again = fakeGh({
      secrets: {
        staging: [...kept.staging, "STRIPE_SECRET_KEY"],
        production: [...kept.production, "STRIPE_SECRET_KEY"],
      },
    });
    const rerun = await setup(
      ["--env", "staging", "production"],
      again,
      true,
      fakeCloudflare(),
      withSecret,
    );
    expect(rerun.code).toBe(0);
    expect(again.stored).toEqual([]);
    expect(rerun.stdout).toMatch(/staging: kept .*STRIPE_SECRET_KEY/);

    const replaced = fakeGh({
      secrets: {
        staging: [...kept.staging, "STRIPE_SECRET_KEY"],
        production: [...kept.production, "STRIPE_SECRET_KEY"],
      },
    });
    await setup(
      ["--env", "staging", "--replace", "STRIPE_SECRET_KEY"],
      replaced,
      true,
      fakeCloudflare(),
      withSecret,
    );
    expect(replaced.stored.map(({ env, name }) => [env, name])).toEqual([
      ["staging", "STRIPE_SECRET_KEY"],
    ]);
  });

  it("stores a public value as a variable in each environment, refuses one that could break out of a string, and keeps it on a re-run", async () => {
    const withPublic = project.replace(
      "    target: cloudflare-static\n",
      "    target: cloudflare-static\n    public: [VITE_POSTHOG_KEY]\n",
    );
    const kept = {
      staging: cloudflareKept,
      production: [...cloudflareKept, "TURBO_VIBE_BUILDS_BUCKET"],
    };
    const answers = new Map([
      ["staging", ['phc_"bad', "phc_staging"]],
      ["production", ["phc_production"]],
    ]);
    const asked: string[] = [];
    const first = fakeGh({ secrets: kept });
    const result = await run(
      ["setup", "--env", "staging", "production"],
      { "turbo-vibe.yaml": withPublic },
      {},
      undefined,
      fakeCloudflare().fetch,
      {
        capture: first.capture,
        askSecret,
        ask: async (question) => {
          asked.push(question);
          const environment = question.split(" ")[0] ?? "";
          return answers.get(environment)?.shift() ?? ask(question);
        },
      },
    );
    expect(result.code).toBe(0);
    expect(first.stored).toEqual([
      {
        env: "staging",
        name: "variable VITE_POSTHOG_KEY",
        value: "phc_staging",
      },
      {
        env: "production",
        name: "variable VITE_POSTHOG_KEY",
        value: "phc_production",
      },
    ]);
    expect(asked).toContain(
      "staging VITE_POSTHOG_KEY (public value of web: the value for staging, which ends up in the built files)",
    );
    expect(result.stdout).toContain(
      "a public value cannot hold a quote, a backslash, a < or a line break\n",
    );

    const again = fakeGh({
      secrets: kept,
      variables: {
        staging: ["VITE_POSTHOG_KEY"],
        production: ["VITE_POSTHOG_KEY"],
      },
    });
    const rerun = await setup(
      ["--env", "staging", "production"],
      again,
      true,
      fakeCloudflare(),
      withPublic,
    );
    expect(rerun.code).toBe(0);
    expect(again.stored).toEqual([]);
    expect(rerun.stdout).toContain("staging: kept VITE_POSTHOG_KEY\n");
  });

  it("stores a build secret once, as a repository secret, and keeps it on a re-run", async () => {
    const withBuildSecret = project.replace(
      'build: { dockerfile: Dockerfile, test: "go test ./..." }',
      'build: { dockerfile: Dockerfile, test: "go test ./...", secrets: [NPM_TOKEN] }',
    );
    const kept = {
      staging: cloudflareKept,
      production: [...cloudflareKept, "TURBO_VIBE_BUILDS_BUCKET"],
    };
    const first = fakeGh({ secrets: kept });
    const result = await setup(
      ["--env", "staging", "production"],
      first,
      true,
      fakeCloudflare(),
      withBuildSecret,
    );
    expect(result.code).toBe(0);
    expect(first.stored).toEqual([
      {
        env: "repository",
        name: "NPM_TOKEN",
        value:
          "value of NPM_TOKEN (build secret of api: one value for every environment, which only the build receives)",
      },
    ]);
    expect(first.calls()).toContain("secret set NPM_TOKEN --repo acme/app");

    const again = fakeGh({
      secrets: { ...kept, repository: ["NPM_TOKEN"] },
    });
    const rerun = await setup(
      ["--env", "staging", "production"],
      again,
      true,
      fakeCloudflare(),
      withBuildSecret,
    );
    expect(rerun.code).toBe(0);
    expect(again.stored).toEqual([]);
    expect(rerun.stdout).toContain("repository: kept NPM_TOKEN\n");
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
    expect(seen.SUPABASE_ACCESS_TOKEN).toBe("value of Supabase access token");
    expect(seen).toMatchObject({
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_TOKEN: "gho_t0ken",
    });
    expect(result.stdout).toContain("staging is ready");
    expect(result.stdout).toContain(
      `staging: kept ${cloudflareKept.join(", ")}; GitHub does not return their values, so this run did not check them`,
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
    expect(writes.map((r) => [r.path, r.token, r.body])).toEqual([
      ["/zones", "value-t1", expect.anything()],
      [
        "/accounts/acc123/r2/buckets",
        "value-t1",
        { name: "acme-turbo-vibe-staging" },
      ],
      [
        "/accounts/acc123/r2/buckets",
        "value-t1",
        { name: "acme-turbo-vibe-production" },
      ],
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
            value: `acme-turbo-vibe-${env}`,
          },
        ]),
      );
    expect(
      gh.stored.filter((secret) => secret.name === "TURBO_VIBE_BUILDS_BUCKET"),
    ).toEqual([
      {
        env: "production",
        name: "TURBO_VIBE_BUILDS_BUCKET",
        value: "acme-turbo-vibe-staging",
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
      buckets: ["acme-turbo-vibe-staging"],
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

  it("asks again for a bootstrap token that cannot create tokens, and creates nothing", async () => {
    const cloudflare = fakeCloudflare({ bootstrapPermissions: ["Zone Read"] });
    const gh = fakeGh();
    const tokens = ["BOOTSTRAP", ""];
    const result = await run(
      ["setup"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      cloudflare.fetch,
      {
        capture: gh.capture,
        ask,
        askSecret: async (question) =>
          question.startsWith("Cloudflare bootstrap token")
            ? (tokens.shift() ?? "")
            : askSecret(question),
      },
    );
    expect(result.code).toBe(1);
    expect(tokens).toEqual([]);
    expect(result.stderr).toContain(
      "lacks Account API Tokens Write, so it cannot create the CI tokens; create one with the steps above and paste it\n",
    );
    expect(result.stderr).toContain(
      "setup needs a Cloudflare bootstrap token; create one with the steps above\n",
    );
    expect(cloudflare.requests.some((r) => r.method === "POST")).toBe(false);
    expect(gh.stored).toEqual([]);
  });

  it("waits for the person to enable R2 and tries the bucket again", async () => {
    const cloudflare = fakeCloudflare({ refusedBuckets: 2 });
    const asked = vi.fn(ask);
    const result = await run(
      ["setup", "--env", "staging"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      cloudflare.fetch,
      { capture: fakeGh().capture, ask: asked, askSecret },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "R2 is not enabled on this account; enable it in R2 Object Storage: https://dash.cloudflare.com/acc123/r2/overview",
    );
    expect(
      asked.mock.calls.filter(([q]) => q.startsWith("Press Enter")),
    ).toHaveLength(2);
    expect(result.stdout).toContain("bucket acme-turbo-vibe-staging created");
  });

  it("stops when the person gives up on R2, and leaves no setup token", async () => {
    const cloudflare = fakeCloudflare({
      refusedBuckets: Number.POSITIVE_INFINITY,
    });
    const result = await run(
      ["setup"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      cloudflare.fetch,
      {
        capture: fakeGh().capture,
        ask: async (q: string) => (q.startsWith("Press Enter") ? "q" : ask(q)),
        askSecret,
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stopped: R2 is not enabled");
    expect(cloudflare.live()).toEqual(["bootstrap"]);
  });

  it("waits for Workers Paid before it creates anything for a container backend", async () => {
    const cloudflare = fakeCloudflare({ unpaidReads: 1 });
    const result = await setup(
      ["--env", "staging"],
      fakeGh(),
      true,
      cloudflare,
    );
    expect(result.code).toBe(0);
    const out = result.stdout;
    expect(out).toContain(
      "Containers need the Workers Paid plan; subscribe in Workers & Pages → Plans: https://dash.cloudflare.com/acc123/workers/plans",
    );
    expect(out.indexOf("the account is on Workers Paid")).toBeLessThan(
      out.indexOf("zone example.com created"),
    );
  });

  it("stops before creating anything when the person gives up on Workers Paid", async () => {
    const cloudflare = fakeCloudflare({
      unpaidReads: Number.POSITIVE_INFINITY,
    });
    const result = await run(
      ["setup"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      cloudflare.fetch,
      {
        capture: fakeGh().capture,
        ask: async (q: string) => (q.startsWith("Press Enter") ? "q" : ask(q)),
        askSecret,
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "stopped: the account is not on Workers Paid",
    );
    expect(
      cloudflare.requests.some(
        (r) => r.method === "POST" && r.path === "/zones",
      ),
    ).toBe(false);
    expect(cloudflare.live()).toEqual(["bootstrap"]);
  });

  it("continues when the plan cannot be read, leaving Workers Paid to the checks", async () => {
    const cloudflare = fakeCloudflare({ billingReadable: false });
    const result = await setup(
      ["--env", "staging"],
      fakeGh(),
      true,
      cloudflare,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "cannot read the account's plan; check confirms Workers Paid at the end",
    );
  });

  it("does not wait for Workers Paid without a container backend", async () => {
    const cloudflare = fakeCloudflare({ unpaidReads: 99 });
    const staticOnly = `version: 1
project: acme
domain: acme.example.com
services:
  web:
    kind: frontend
    target: cloudflare-static
    build: { command: "pnpm build", output: dist }
`;
    const result = await setupWith(staticOnly, cloudflare.fetch, fakeGh());
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Workers Paid");
    const setupToken = cloudflare.created("turbo-vibe-acme-setup");
    expect(JSON.stringify(setupToken?.body)).not.toContain("Billing Read");
  });

  describe("the Cloudflare step", () => {
    const guided = (
      cloudflare: ReturnType<typeof fakeCloudflare>,
      replies: Record<string, unknown>,
      runner = vi.fn<Runner>(async () => 0),
      tokens = ["BOOTSTRAP"],
    ) => {
      const { prompts, asked } = fakePrompts(replies);
      const questions: string[] = [];
      const gh = fakeGh();
      return {
        asked,
        questions,
        runner,
        gh,
        result: run(
          ["setup", "--env", "staging"],
          { "turbo-vibe.yaml": project },
          {},
          runner,
          cloudflare.fetch,
          {
            capture: gh.capture,
            ask: async (question) => {
              questions.push(question);
              return ask(question);
            },
            askSecret: async (question) =>
              question.startsWith("Cloudflare bootstrap token")
                ? (tokens.shift() ?? "")
                : askSecret(question),
            prompts,
          },
        ),
      };
    };

    it("shows the clicks and permissions, and uses the token's only account without a question", async () => {
      const { result, questions } = guided(fakeCloudflare(), {
        "Open this page": false,
      });
      const { code, stdout } = await result;
      expect(code).toBe(0);
      expect(stdout).toContain(
        "Step 1 of 1 · Cloudflare\n  Plan: Workers Paid, which Containers need\n  1. Open the page below: it fills in the name",
      );
      expect(stdout).toContain(
        "  Permissions: Account API Tokens: Edit, and nothing else",
      );
      expect(stdout).toContain(
        "cloudflare: the bootstrap token works on the account Acme\n",
      );
      expect(questions.some((q) => q.includes("account"))).toBe(false);
    });

    it("asks which account by name when the token sees several", async () => {
      const cloudflare = fakeCloudflare({
        accounts: [
          { id: "other9", name: "Other" },
          { id: "acc123", name: "Acme" },
        ],
      });
      const { result, asked } = guided(cloudflare, {
        "Open this page": false,
        "Cloudflare account": "1",
      });
      expect((await result).code).toBe(0);
      expect(
        asked
          .find(({ message }) => message === "Cloudflare account")
          ?.options?.map(({ label }) => label),
      ).toEqual(["Other (other9)", "Acme (acc123)"]);
    });

    it("ends the run when the person cancels the account choice, storing nothing", async () => {
      const cloudflare = fakeCloudflare({
        accounts: [
          { id: "other9", name: "Other" },
          { id: "acc123", name: "Acme" },
        ],
      });
      const { result, gh } = guided(cloudflare, {
        "Open this page": false,
        "Cloudflare account": undefined,
      });
      const { code, stderr } = await result;
      expect(code).toBe(130);
      expect(stderr).toBe("setup cancelled\n");
      expect(gh.stored).toEqual([]);
      expect(cloudflare.requests.some((r) => r.method === "POST")).toBe(false);
    });

    it("tells a token that sees no account from one Cloudflare refuses", async () => {
      const { result } = guided(
        fakeCloudflare({ accounts: [] }),
        { "Open this page": false },
        undefined,
        ["BOOTSTRAP", "WRONG", ""],
      );
      const { code, stderr } = await result;
      expect(code).toBe(1);
      expect(stderr).toContain(
        "the bootstrap token sees no Cloudflare account; create it under Manage Account → Account API Tokens, so the account owns it, and paste it\n",
      );
      expect(stderr).toContain(
        "Cloudflare refuses the bootstrap token (HTTP 401); create one with the steps above and paste it\n",
      );
    });

    it("links to a token page prefilled with the name and the one permission", () => {
      const url = new URL(bootstrapTokenUrl);
      expect(url.origin).toBe("https://dash.cloudflare.com");
      expect(url.searchParams.get("to")).toBe("/:account/api-tokens");
      expect(
        JSON.parse(url.searchParams.get("permissionGroupKeys") ?? ""),
      ).toEqual([{ key: "account_api_tokens", type: "edit" }]);
      expect(url.searchParams.get("name")).toBe("turbo-vibe bootstrap");
    });

    it("opens the page on request, and goes on with the printed address when no browser opens", async () => {
      const { result, runner } = guided(
        fakeCloudflare(),
        { "Open this page": true },
        vi.fn<Runner>(async () => 1),
      );
      const { code, stdout } = await result;
      expect(code).toBe(0);
      expect(runner.mock.calls[0]?.[1]).toContain(bootstrapTokenUrl);
      expect(stdout).toContain(
        "could not open a browser; open the address above\n",
      );
    });
  });

  it("asks for no bootstrap token when every environment has the Cloudflare secrets", async () => {
    const cloudflare = fakeCloudflare();
    const gh = fakeGh({
      secrets: {
        staging: cloudflareKept,
        production: [...cloudflareKept, "TURBO_VIBE_BUILDS_BUCKET"],
      },
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
      ...requiredPermissions({
        config: parsed.config,
        environment: "staging",
      }),
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
            "com.cloudflare.edge.r2.bucket.acc123_default_acme-turbo-vibe-staging":
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
        production: [...cloudflareKept, "TURBO_VIBE_BUILDS_BUCKET"].filter(
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

  it("replaces both R2 keys, and the bucket name they reach, when one of them is gone", async () => {
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
      "TURBO_VIBE_STATE_BUCKET",
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
    const ask = vi.fn(async (_question: string) => "y");
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
  const allKept = {
    staging: cloudflareKept,
    production: [...cloudflareKept, "TURBO_VIBE_BUILDS_BUCKET"],
  };

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

  it("checks the token but stores no organization when the config names one", async () => {
    const gh = fakeGh({ secrets: allKept });
    const fetch = vendors(fakeCloudflare());
    const { stdout } = await setupWith(withDatabase, fetch, gh);
    expect(gh.stored.map((s) => s.name)).not.toContain("SUPABASE_ORGANIZATION");
    expect(stdout).toContain(
      "the Supabase token works and sees the organization Acme\n",
    );
  });

  it("stores the only Vercel team the token sees, without a question", async () => {
    const gh = fakeGh({ secrets: allKept });
    const result = await setupWith(onVercel, vendors(fakeCloudflare()), gh);
    expect(result.code).toBe(0);
    expect(storedValue(gh, "staging", "VERCEL_TEAM_ID")).toBe("team_1");
    expect(storedValue(gh, "production", "VERCEL_API_TOKEN")).toBe(
      "value of Vercel access token",
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

  it("asks again for a Supabase token that Supabase refuses, and never prints a token", async () => {
    const gh = fakeGh({ secrets: allKept });
    const statuses = [401, 200];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
      String(input) === "https://api.supabase.com/v1/organizations"
        ? Response.json([{ id: "acme", name: "acme" }], {
            status: statuses.shift() ?? 200,
          })
        : fakeCloudflare().fetch(input, init),
    );
    const tokens = ["sbp_first_secret", "sbp_second_secret"];
    const result = await setupWith(withDatabase, fetch, gh, {
      askSecret: async (q: string) =>
        q === "Supabase access token" ? (tokens.shift() ?? "") : askSecret(q),
    });
    expect(result.code).toBe(0);
    expect(tokens).toEqual([]);
    expect(result.stderr).toContain(
      "Supabase refuses the token (HTTP 401); create a new one with the steps above and paste it\n",
    );
    expect(result.stdout).toContain(
      "the Supabase token works and sees the organization acme\n",
    );
    expect(storedValue(gh, "staging", "SUPABASE_ACCESS_TOKEN")).toBe(
      "sbp_second_secret",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("_secret");
  });

  it("asks again for a WorkOS key that WorkOS refuses", async () => {
    const gh = fakeGh({ secrets: allKept });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const key = new Headers(init?.headers).get("authorization") ?? "";
      return String(input).startsWith("https://api.workos.com/")
        ? Response.json({}, { status: key.includes("revoked") ? 401 : 200 })
        : fakeCloudflare().fetch(input, init);
    });
    const answers: Record<string, string[]> = {
      staging: ["sk_test_revoked", "sk_test_right"],
      production: ["sk_live_right"],
    };
    const result = await setupWith(withSignIn, fetch, gh, {
      askSecret: async (q: string) => {
        const env = q.split(" ")[0] ?? "";
        if (q.includes("WORKOS_API_KEY")) return answers[env]?.shift() ?? "";
        return `value of ${q}`;
      },
    });
    expect(result.code).toBe(0);
    expect(storedValue(gh, "staging", "WORKOS_API_KEY")).toBe("sk_test_right");
    expect(result.stderr).toContain(
      "WorkOS refuses the key (HTTP 401); copy it again with the steps above\n",
    );
  });

  it("numbers the vendor steps across the run, and shows WorkOS once for every environment", async () => {
    const gh = fakeGh();
    const everyVendor = `${onVercel}  db:
    kind: database
    target: supabase
    region: eu-central-1
  auth:
    kind: identity
    target: workos
`;
    const result = await setupWith(everyVendor, fakeCloudflare().fetch, gh, {
      askSecret: async (q: string) =>
        q.includes("WORKOS_API_KEY")
          ? q.startsWith("production")
            ? "sk_live_key"
            : "sk_test_key"
          : askSecret(q),
    });
    expect(result.code).toBe(0);
    const headers = result.stdout.match(/Step \d of \d · \w+/g);
    expect(headers).toEqual([
      "Step 1 of 4 · Cloudflare",
      "Step 2 of 4 · Supabase",
      "Step 3 of 4 · Vercel",
      "Step 4 of 4 · WorkOS",
    ]);
  });

  it("asks again when the network fails during a check", async () => {
    const gh = fakeGh({ secrets: allKept });
    let failures = 1;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input) === "https://api.vercel.com/v2/teams" && failures-- > 0)
        throw new TypeError("fetch failed");
      return fakeCloudflare().fetch(input, init);
    });
    const result = await setupWith(onVercel, fetch, gh);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      "could not check it (fetch failed); check the connection and paste it again\n",
    );
    expect(storedValue(gh, "staging", "VERCEL_TEAM_ID")).toBe("team_1");
  });

  it("reports a refused value on the spinner in a terminal", async () => {
    const gh = fakeGh({ secrets: allKept });
    const statuses = [401, 200];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
      String(input) === "https://api.vercel.com/v2/teams"
        ? Response.json(
            { teams: [{ id: "team_1", name: "Acme" }] },
            { status: statuses.shift() ?? 200 },
          )
        : fakeCloudflare().fetch(input, init),
    );
    const { prompts, asked } = fakePrompts({ "Open this page": false });
    const result = await setupWith(onVercel, fetch, gh, { prompts });
    expect(result.code).toBe(0);
    expect(
      asked
        .filter(({ message }) => message === "checking the Vercel token")
        .map(({ problems }) => problems),
    ).toEqual([
      [
        "Vercel refuses the token (HTTP 401); create a new one with the steps above and paste it",
      ],
      [],
    ]);
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

describe("setup on re-runs and other environments", () => {
  const everything = [...cloudflareKept, "SUPABASE_ACCESS_TOKEN"];

  it("asks again only for a secret named by --replace, in every environment", async () => {
    const gh = fakeGh({
      secrets: {
        staging: everything,
        production: [...everything, "TURBO_VIBE_BUILDS_BUCKET"],
      },
    });
    const cloudflare = fakeCloudflare();
    const result = await setup(
      ["--replace", "SUPABASE_ACCESS_TOKEN"],
      gh,
      true,
      cloudflare,
      withDatabase,
    );
    expect(result.code).toBe(0);
    expect(gh.stored.map((s) => [s.env, s.name])).toEqual([
      ["staging", "SUPABASE_ACCESS_TOKEN"],
      ["production", "SUPABASE_ACCESS_TOKEN"],
    ]);
    expect(cloudflare.requests).toEqual([]);
  });

  it("creates the Cloudflare token again for --replace CLOUDFLARE_API_TOKEN", async () => {
    const gh = fakeGh({
      secrets: {
        staging: cloudflareKept,
        production: [...cloudflareKept, "TURBO_VIBE_BUILDS_BUCKET"],
      },
    });
    const cloudflare = fakeCloudflare({
      existingTokens: ["turbo-vibe-acme-staging", "turbo-vibe-acme-production"],
    });
    const result = await setup(
      ["--replace", "CLOUDFLARE_API_TOKEN"],
      gh,
      true,
      cloudflare,
    );
    expect(result.code).toBe(0);
    expect(gh.stored.map((s) => [s.env, s.name])).toEqual([
      ["staging", "CLOUDFLARE_API_TOKEN"],
      ["production", "CLOUDFLARE_API_TOKEN"],
    ]);
    expect(cloudflare.created("turbo-vibe-acme-staging")).toBeDefined();
    expect(
      cloudflare.live().filter((name) => name === "turbo-vibe-acme-staging"),
    ).toHaveLength(1);
  });

  it("refuses a --replace name the project does not use, before any change", async () => {
    const gh = fakeGh();
    const result = await setup(["--replace", "VERCEL_API_TOKEN"], gh);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "--replace VERCEL_API_TOKEN: this project does not use that secret",
    );
    expect(gh.capture).not.toHaveBeenCalled();
  });

  it("sets up an environment such as live like staging: no reviewer, a staging WorkOS key", async () => {
    let checkedAs = "";
    let github: string | undefined;
    checks.list = [
      async ({ environment, githubEnvironment }) => {
        checkedAs = environment;
        github = githubEnvironment;
        return [];
      },
    ];
    const gh = fakeGh({ secrets: { live: cloudflareKept } });
    const result = await run(
      ["setup", "--env", "live"],
      { "turbo-vibe.yaml": withSignIn },
      {},
      undefined,
      fakeCloudflare().fetch,
      {
        capture: gh.capture,
        ask,
        askSecret: async (q: string) =>
          q.includes("WORKOS_API_KEY") ? "sk_test_live" : `value of ${q}`,
      },
    );
    expect(result.code).toBe(0);
    expect(gh.calls()).toContain("api -X PUT repos/acme/app/environments/live");
    expect(gh.calls().some((call) => call.includes("reviewers"))).toBe(false);
    expect(storedValue(gh, "live", "WORKOS_API_KEY")).toBe("sk_test_live");
    expect(checkedAs).toBe("staging");
    expect(github).toBe("live");
    expect(result.stdout).toContain("live is ready");
  });

  it("refuses an environment name GitHub cannot use", async () => {
    const gh = fakeGh();
    const result = await setup(["--env", "my env"], gh);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("my env cannot name a GitHub environment");
    expect(gh.capture).not.toHaveBeenCalled();
  });
});

describe("setup --list", () => {
  it("asks the person to enable Zero Trust once when an environment is private", async () => {
    const result = await run(["setup", "--list"], {
      "turbo-vibe.yaml": project.replace(
        "services:",
        "environments:\n  staging:\n    access: { emails: [ada@example.com] }\nservices:",
      ),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Enable Zero Trust once, for the private environments: open https://one.dash.cloudflare.com/, choose a team name and the Free plan",
    );
  });

  it("names the accounts, plans and person steps for the project's targets, and changes nothing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runner = vi.fn(async () => 0);
    const capture = vi.fn<Capturer>();
    const result = await run(
      ["setup", "--list"],
      {
        "turbo-vibe.yaml": `${withSignIn}  db:\n    kind: database\n    target: supabase\n    region: eu-central-1\n`,
      },
      {},
      runner,
      fetch,
      { capture },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Subscribe to Workers Paid");
    expect(result.stdout).toContain("Create the Supabase organization");
    expect(result.stdout).not.toContain("Zero Trust");
    expect(result.stdout).toContain("production needs billing");
    expect(result.stdout).not.toContain("Vercel");
    expect(result.stdout).toContain(
      "staging: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID",
    );
    expect(result.stdout).toContain("  staging: acme-turbo-vibe-staging\n");
    expect(result.stdout).toContain(
      "  production: acme-turbo-vibe-production (and read-only access to acme-turbo-vibe-staging, for the builds it promotes)\n",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("prints each token's steps exactly as setup shows them", async () => {
    const result = await run(["setup", "--list"], {
      "turbo-vibe.yaml": withDatabase,
    });
    const config = parseConfig(withDatabase);
    if (!config.ok) throw new Error("invalid fixture");
    for (const step of [cloudflareStep, supabaseStep])
      expect(result.stdout).toContain(
        [
          `  ${step.vendor}`,
          ...stepLines(step, config.config).map((line) => `  ${line}`),
        ].join("\n"),
      );
    for (const line of [
      ...supabaseStep.clicks,
      supabaseStep.permissions,
      supabaseStep.url,
    ])
      expect(result.stdout).toContain(line);
    expect(result.stdout).not.toContain("  WorkOS\n");
  });

  it("tells the person to have the application's own values ready, by kind", async () => {
    const result = await run(["setup", "--list"], {
      "turbo-vibe.yaml": project
        .replace(
          "    target: cloudflare-container\n",
          "    target: cloudflare-container\n    secrets: [POSTMARK_TOKEN]\n",
        )
        .replace(
          "    target: cloudflare-static\n",
          "    target: cloudflare-static\n    public: [VITE_POSTHOG_KEY]\n",
        ),
    });
    expect(result.stdout).toContain(
      "Have the application's own values ready, which setup asks for: POSTMARK_TOKEN (one per environment), VITE_POSTHOG_KEY (public, one per environment)",
    );
  });

  it("names the build secrets setup stores once, for the repository", async () => {
    const result = await run(["setup", "--list"], {
      "turbo-vibe.yaml": project.replace(
        'build: { dockerfile: Dockerfile, test: "go test ./..." }',
        "build: { dockerfile: Dockerfile, secrets: [NPM_TOKEN] }",
      ),
    });
    expect(result.stdout).toContain(
      "Build secrets setup stores once, as repository secrets\n  NPM_TOKEN\n",
    );
  });

  it("names the public values setup stores as variables, per environment", async () => {
    const result = await run(["setup", "--list"], {
      "turbo-vibe.yaml": project.replace(
        "    target: cloudflare-static\n",
        "    target: cloudflare-static\n    public: [VITE_POSTHOG_KEY]\n",
      ),
    });
    expect(result.stdout).toContain(
      "Public values setup stores as variables in each GitHub environment\n  staging: VITE_POSTHOG_KEY\n  production: VITE_POSTHOG_KEY\n",
    );
  });

  it("names a declared secret in every environment's list", async () => {
    const result = await run(["setup", "--list"], {
      "turbo-vibe.yaml": project.replace(
        "    target: cloudflare-container\n",
        "    target: cloudflare-container\n    secrets: [STRIPE_SECRET_KEY]\n",
      ),
    });
    expect(result.stdout).toMatch(/\n {2}staging: [^\n]*STRIPE_SECRET_KEY/);
    expect(result.stdout).toMatch(/\n {2}production: [^\n]*STRIPE_SECRET_KEY/);
  });

  it("names the Vercel token and the Pro plan, and no Workers Paid, for a static site on Vercel", async () => {
    const site = `version: 1
project: acme
domain: acme.example.com
services:
  web:
    kind: frontend
    target: vercel-static
    build: { command: "pnpm build", output: dist }
`;
    const result = await run(["setup", "--list"], { "turbo-vibe.yaml": site });
    expect(result.stdout).toContain(
      "  Vercel\n    Plan: Hobby, or Pro for a commercial project\n",
    );
    expect(result.stdout).toContain("a commercial project needs the Pro plan");
    expect(result.stdout).not.toContain("Workers Paid");
  });

  it("names Supabase Pro when the project has previews, which run on a database branch", async () => {
    const result = await run(["setup", "--list"], {
      "turbo-vibe.yaml": withDatabase.replace(
        "services:",
        "previews: true\nservices:",
      ),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "on the Pro plan (the config asks for plan: paid, staging: branch or previews)",
    );
  });

  it("gives production's R2 token write on its own bucket and only read on staging's", async () => {
    const cloudflare = fakeCloudflare();
    expect((await setup([], fakeGh(), true, cloudflare)).code).toBe(0);
    expect(cloudflare.created("turbo-vibe-acme-production-r2")?.body).toEqual({
      name: "turbo-vibe-acme-production-r2",
      policies: [
        {
          effect: "allow",
          resources: {
            "com.cloudflare.edge.r2.bucket.acc123_default_acme-turbo-vibe-production":
              "*",
          },
          permission_groups: [
            { id: "id-Workers R2 Storage Bucket Item Write" },
          ],
        },
        {
          effect: "allow",
          resources: {
            "com.cloudflare.edge.r2.bucket.acc123_default_acme-turbo-vibe-staging":
              "*",
          },
          permission_groups: [{ id: "id-Workers R2 Storage Bucket Item Read" }],
        },
      ],
    });
    expect(
      cloudflare.created("turbo-vibe-acme-staging-r2")?.body,
    ).toMatchObject({ policies: [expect.anything()] });
  });

  it("creates staging's bucket when only production is set up, since production reads it", async () => {
    const cloudflare = fakeCloudflare();
    expect(
      (await setup(["--env", "production"], fakeGh(), true, cloudflare)).code,
    ).toBe(0);
    expect(
      cloudflare.requests
        .filter((r) => r.method === "POST" && r.path.endsWith("/r2/buckets"))
        .map((r) => (r.body as { name: string }).name),
    ).toEqual(["acme-turbo-vibe-production", "acme-turbo-vibe-staging"]);
  });

  it("points the stored bucket names at the new token's buckets when it replaces an older R2 token", async () => {
    const older = [...cloudflareKept];
    const gh = fakeGh({ secrets: { staging: older, production: older } });
    const cloudflare = fakeCloudflare();
    expect(
      (await setup(["--replace", "AWS_ACCESS_KEY_ID"], gh, true, cloudflare))
        .code,
    ).toBe(0);
    for (const env of ["staging", "production"])
      expect(storedValue(gh, env, "TURBO_VIBE_STATE_BUCKET")).toBe(
        `acme-turbo-vibe-${env}`,
      );
    expect(storedValue(gh, "production", "TURBO_VIBE_BUILDS_BUCKET")).toBe(
      "acme-turbo-vibe-staging",
    );
  });

  it("names what one Cloudflare account leaves shared, for a container backend with previews", async () => {
    const result = await run(["setup", "--list"], {
      "turbo-vibe.yaml": project.replace(
        "services:",
        "previews: true\nservices:",
      ),
    });
    const limits = result.stdout.slice(
      result.stdout.indexOf("What one Cloudflare account leaves shared"),
    );
    expect(limits).toContain(
      "can deploy any Worker in the account, production's included, and change any container application",
    );
    expect(limits).toContain("edit the zone's DNS records and routes");
    const previews = limits.indexOf("Previews run pull request code");
    expect(previews).toBeGreaterThan(limits.indexOf("any Worker"));
    expect(limits).toContain("deployment-branch rules");
    expect(limits).toContain("does not support yet");
  });

  it("names only the shared DNS and the Vercel team for a Vercel page without previews", async () => {
    const result = await run(["setup", "--list"], {
      "turbo-vibe.yaml": `version: 1
project: acme
domain: acme.example.com
services:
  web:
    kind: frontend
    target: vercel-static
    build: { command: "pnpm build", output: dist }
`,
    });
    const limits = result.stdout.slice(
      result.stdout.indexOf("What one Cloudflare account leaves shared"),
    );
    expect(limits).toContain(
      "edit the zone's DNS records, so it could point production's hostnames elsewhere",
    );
    expect(limits).toContain(
      "The Vercel token reaches every project in its team",
    );
    expect(limits).not.toContain("any Worker");
    expect(limits).not.toContain("Previews");
  });
});

describe("setup with previews", () => {
  const withPreviews = project.replace(
    "services:",
    "previews: true\nservices:",
  );

  it("creates a preview environment with its own bucket and tokens, and no branch limit", async () => {
    const gh = fakeGh();
    const cloudflare = fakeCloudflare();
    const result = await setupWith(withPreviews, cloudflare.fetch, gh);
    expect(result.code).toBe(0);
    expect(gh.calls()).toContain(
      "api -X PUT repos/acme/app/environments/preview",
    );
    expect(
      gh
        .calls()
        .some((call) =>
          call.includes("environments/preview/deployment-branch-policies"),
        ),
    ).toBe(false);
    expect(storedValue(gh, "preview", "TURBO_VIBE_STATE_BUCKET")).toBe(
      "acme-turbo-vibe-preview",
    );
    const buckets = JSON.stringify(
      cloudflare.created("turbo-vibe-acme-preview-r2")?.body,
    ).match(/acme-turbo-vibe-[a-z-]+/g);
    expect(buckets).toEqual(["acme-turbo-vibe-preview"]);
    expect(cloudflare.created("turbo-vibe-acme-preview")).toBeDefined();
  });

  it("gives staging's CI token Zone Settings Write on the zone, and the preview's none", async () => {
    const cloudflare = fakeCloudflare();
    await setupWith(withPreviews, cloudflare.fetch, fakeGh());
    const policies = (name: string) =>
      (
        cloudflare.created(name)!.body as {
          policies: {
            resources: Record<string, unknown>;
            permission_groups: { id: string }[];
          }[];
        }
      ).policies;
    const onZone = policies("turbo-vibe-acme-staging").find(
      (policy) =>
        "com.cloudflare.api.account.zone.zone-new" in policy.resources,
    );
    expect(onZone?.permission_groups).toContainEqual({
      id: "id-Zone Settings Write",
    });
    expect(JSON.stringify(policies("turbo-vibe-acme-preview"))).not.toContain(
      "Zone Settings Write",
    );
  });

  it("gives every CI token Access on the zone only, though no environment is private", async () => {
    const cloudflare = fakeCloudflare();
    await setupWith(withPreviews, cloudflare.fetch, fakeGh());
    for (const environment of ["staging", "production", "preview"]) {
      const { policies } = (cloudflare.created(`turbo-vibe-acme-${environment}`)
        ?.body ?? { policies: [] }) as {
        policies: {
          resources: Record<string, unknown>;
          permission_groups: { id: string }[];
        }[];
      };
      const holding = policies.filter((policy) =>
        policy.permission_groups.some(
          ({ id }) => id === "id-Access: Apps and Policies Write",
        ),
      );
      expect(holding.map((policy) => Object.keys(policy.resources))).toEqual([
        ["com.cloudflare.api.account.zone.zone-new"],
      ]);
    }
  });

  it("creates no preview environment when the config has no previews", async () => {
    const gh = fakeGh();
    await setupWith(project, fakeCloudflare().fetch, gh);
    expect(
      gh.calls().some((call) => call.includes("environments/preview")),
    ).toBe(false);
  });
});
