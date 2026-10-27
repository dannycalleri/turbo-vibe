import { describe, expect, it, vi } from "vitest";
import type { Capturer } from "../src/run.js";
import { fakePrompts, project, run } from "./harness.js";

const newest = "b".repeat(40);
const older = "a".repeat(40);

const deployments = JSON.stringify({
  data: {
    repository: {
      deployments: {
        nodes: [
          {
            commitOid: newest,
            latestStatus: {
              state: "SUCCESS",
              createdAt: "2026-10-26T12:00:00Z",
            },
            commit: { messageHeadline: "feat: newest" },
          },
          {
            commitOid: older,
            latestStatus: {
              state: "SUCCESS",
              createdAt: "2026-10-25T12:00:00Z",
            },
            commit: { messageHeadline: "fix: older" },
          },
        ],
      },
    },
  },
});

function github({
  signedIn = true,
  listing = deployments,
  listed = true,
  newRun = true,
  runs: initialRuns = 1,
  repository = true,
}: {
  signedIn?: boolean;
  listing?: string;
  listed?: boolean;
  newRun?: boolean;
  runs?: number;
  repository?: boolean;
} = {}) {
  let runs = initialRuns;
  const capture = vi.fn<Capturer>(async (_command, args) => {
    if (args[0] === "auth")
      return signedIn
        ? { code: 0, stdout: "" }
        : { code: 1, stdout: "", stderr: "not logged in\n" };
    if (args[0] === "repo")
      return repository
        ? { code: 0, stdout: "acme/app\n" }
        : { code: 1, stdout: "", stderr: "not a git repository\n" };
    if (args[0] === "api" && args[1] === "user")
      return { code: 0, stdout: "ada\n" };
    if (args[0] === "api")
      return listed
        ? { code: 0, stdout: listing }
        : { code: 1, stdout: "", stderr: "API rate limit exceeded\n" };
    if (args[0] === "workflow") {
      if (newRun) runs++;
      return { code: 0, stdout: "" };
    }
    if (args[0] === "run")
      return {
        code: 0,
        stdout: JSON.stringify(
          runs === 0
            ? []
            : [
                {
                  databaseId: 100 + runs,
                  url: `https://github.com/acme/app/actions/runs/${100 + runs}`,
                },
              ],
        ),
      };
    return { code: 1, stdout: "" };
  });
  const started = () =>
    capture.mock.calls
      .filter(([, args]) => args[0] === "workflow")
      .map(([, args]) => args.join(" "));
  return { capture, started };
}

async function ship(
  args: string[],
  gh: ReturnType<typeof github>,
  replies?: Record<string, unknown>,
) {
  const terminal = replies ? fakePrompts(replies) : undefined;
  const sleep = vi.fn(async () => {});
  const result = await run(
    ["ship", ...args],
    { "turbo-vibe.yaml": project },
    { GITHUB_REPOSITORY: "acme/app" },
    undefined,
    undefined,
    {
      capture: gh.capture,
      sleep,
      ...(terminal ? { prompts: terminal.prompts } : {}),
    },
  );
  return { ...result, sleep, asked: terminal?.asked ?? [] };
}

describe("turbo-vibe ship", () => {
  it("lists runs it dispatched itself, in this folder's repository, and never reports a run without an ID", async () => {
    const gh = github({ runs: 0, newRun: false });
    const { code, stdout } = await ship(["--build-id", newest], gh);
    expect(code).toBe(0);
    expect(stdout).toContain("find the run under production.yml");
    expect(stdout).not.toContain("null");
    const listing = gh.capture.mock.calls.find(([, args]) => args[0] === "run");
    expect(listing?.[1]).toEqual(
      expect.arrayContaining([
        "--repo",
        "acme/app",
        "--event",
        "workflow_dispatch",
        "--user",
        "ada",
      ]),
    );
  });

  it("names a rollback without a terminal, and passes --allow-deletions on", async () => {
    const gh = github();
    const { code, stdout } = await ship(
      ["--build-id", older, "--allow-deletions"],
      gh,
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      `this is a rollback: ${older.slice(0, 12)} is older than the newest build ${newest.slice(0, 12)}\n`,
    );
    expect(gh.started()).toEqual([
      `workflow run production.yml --repo acme/app -f confirm-build=${older} -f allow-deletions=true`,
    ]);
  });

  it("stops when it cannot tell the folder's repository, and starts nothing", async () => {
    const gh = github({ repository: false });
    const { code, stderr } = await ship(["--build-id", newest], gh);
    expect(code).toBe(1);
    expect(stderr).toContain(
      "cannot tell this folder's GitHub repository or your GitHub login",
    );
    expect(gh.started()).toEqual([]);
  });

  it("refuses an empty --build-id instead of ignoring it", async () => {
    const gh = github();
    const { code, stderr } = await ship(["--build-id", ""], gh);
    expect(code).toBe(1);
    expect(stderr).toBe('"" is not a full commit SHA\n');
    expect(gh.capture).not.toHaveBeenCalled();
  });

  it("lists builds of this folder's repository even when GITHUB_REPOSITORY names another", async () => {
    const gh = github();
    await run(
      ["ship", "--build-id", newest],
      { "turbo-vibe.yaml": project },
      { GITHUB_REPOSITORY: "acme/other" },
      undefined,
      undefined,
      { capture: gh.capture },
    );
    const graphql = gh.capture.mock.calls.find(
      ([, args]) => args[0] === "api" && args[1] === "graphql",
    );
    expect(graphql?.[1]).toEqual(
      expect.arrayContaining(["owner=acme", "name=app"]),
    );
  });

  it("starts Deploy to production with the newest build by default, and prints the run", async () => {
    const gh = github();
    const { code, stdout, asked } = await ship([], gh, {
      "Which build": "",
      "Start Deploy to production": true,
    });
    expect(code).toBe(0);
    expect(asked[0]?.options?.map((option) => option.value)).toEqual([
      newest,
      older,
    ]);
    expect(gh.started()).toEqual([
      `workflow run production.yml --repo acme/app -f confirm-build=${newest}`,
    ]);
    expect(stdout).toContain(
      `started Deploy to production with ${newest}: https://github.com/acme/app/actions/runs/102\n`,
    );
    expect(stdout).toContain(
      "A required reviewer of the production environment approves it there",
    );
  });

  it("asks a rollback question for an older build", async () => {
    const gh = github();
    const { code, asked } = await ship([], gh, {
      "Which build": older,
      "Roll production back?": true,
    });
    expect(code).toBe(0);
    expect(asked.map((question) => question.message)).toContain(
      `Roll production back? ${older.slice(0, 12)} is older than the newest build ${newest.slice(0, 12)}.`,
    );
    expect(gh.started()).toEqual([
      `workflow run production.yml --repo acme/app -f confirm-build=${older}`,
    ]);
  });

  it("starts nothing when the person says no, or presses Ctrl-C", async () => {
    const declined = github();
    expect(
      (
        await ship([], declined, {
          "Which build": "",
          "Start Deploy to production": false,
        })
      ).code,
    ).toBe(0);
    expect(declined.started()).toEqual([]);
    const cancelled = github();
    expect((await ship([], cancelled, {})).code).toBe(130);
    expect(cancelled.started()).toEqual([]);
    const atConfirm = github();
    expect((await ship([], atConfirm, { "Which build": "" })).code).toBe(130);
    expect(atConfirm.started()).toEqual([]);
  });

  it("says where to find the run when no new run shows up", async () => {
    const gh = github({ newRun: false });
    const { code, stdout, sleep } = await ship(["--build-id", newest], gh);
    expect(code).toBe(0);
    expect(stdout).toContain(
      `started Deploy to production with ${newest}; find the run under production.yml in the Actions tab\n`,
    );
    expect(sleep).toHaveBeenCalledTimes(10);
  });

  it("notes a given build that GitHub does not list, and starts it for the run to check", async () => {
    const unlisted = "c".repeat(40);
    const gh = github();
    const { code, stdout } = await ship(["--build-id", unlisted], gh);
    expect(code).toBe(0);
    expect(stdout).toContain(
      `GitHub lists no passing staging deployment for ${unlisted.slice(0, 12)}; the run checks the build records and stops unless it passed\n`,
    );
    expect(gh.started()).toEqual([
      `workflow run production.yml --repo acme/app -f confirm-build=${unlisted}`,
    ]);
  });

  it("starts a given build when GitHub cannot list the builds, and refuses to choose without the list", async () => {
    const given = github({ listed: false });
    const { code, stdout } = await ship(["--build-id", older], given);
    expect(code).toBe(0);
    expect(stdout).toContain(
      "cannot list the builds that passed staging (API rate limit exceeded), so ship cannot tell whether",
    );
    expect(given.started()).toHaveLength(1);
    const choosing = github({ listed: false });
    const refused = await ship([], choosing, {});
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "cannot list the builds that passed staging: API rate limit exceeded",
    );
    expect(choosing.started()).toEqual([]);
  });

  it("says to sign in to gh, and starts nothing, when gh is signed out", async () => {
    const gh = github({ signedIn: false });
    const { code, stderr } = await ship([], gh, {});
    expect(code).toBe(1);
    expect(stderr).toContain("run gh auth login, then ship again");
    expect(gh.started()).toEqual([]);
  });

  it("needs --build-id without a terminal, and then asks nothing", async () => {
    const without = github();
    const refused = await ship([], without);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(
      "without a terminal, ship needs --build-id <sha>\n",
    );
    expect(without.capture).not.toHaveBeenCalled();
    const given = github();
    expect((await ship(["--build-id", older], given)).code).toBe(0);
    expect(given.started()).toEqual([
      `workflow run production.yml --repo acme/app -f confirm-build=${older}`,
    ]);
  });

  it("says so when no build has passed staging", async () => {
    const gh = github({
      listing: JSON.stringify({
        data: { repository: { deployments: { nodes: [] } } },
      }),
    });
    const { code, stderr } = await ship([], gh, {});
    expect(code).toBe(1);
    expect(stderr).toContain("no build has passed staging yet");
    expect(gh.started()).toEqual([]);
  });
});
