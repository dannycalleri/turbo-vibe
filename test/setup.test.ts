import { describe, expect, it, vi } from "vitest";
import type { Capturer } from "../src/run.js";
import { project, run } from "./harness.js";

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

const ask = async () => "";
const askSecret = async (question: string) => `value of ${question}\n`;

function setup(argv: string[], gh: ReturnType<typeof fakeGh>, withAsk = true) {
  return run(
    ["setup", ...argv],
    { "turbo-vibe.yaml": project },
    {},
    undefined,
    undefined,
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
      undefined,
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
    const gh = fakeGh();
    const result = await run(
      ["setup", "--env", "staging"],
      { "turbo-vibe.yaml": project },
      {},
      undefined,
      undefined,
      { capture: gh.capture, ask, askSecret: async () => "  \n" },
    );
    expect(result.code).toBe(0);
    expect(gh.stored).toEqual([]);
    expect(result.stdout).toContain(
      "staging: CLOUDFLARE_API_TOKEN skipped, nothing entered",
    );
  });
});
