import { describe, expect, it, vi } from "vitest";
import type { Io } from "../src/io.js";
import type { Capturer } from "../src/run.js";
import {
  commitOf,
  describePromotion,
  type StagingBuild,
  stagingBuilds,
} from "../src/staging-builds.js";

const sha = (digit: string) => digit.repeat(40);

function deployment(
  digit: string,
  state: string,
  at: string,
  subject = `change ${digit}`,
) {
  return {
    commitOid: sha(digit),
    latestStatus: { state, createdAt: at },
    commit: { messageHeadline: subject },
  };
}

function io(answer: Awaited<ReturnType<Capturer>>, repository = "acme/app") {
  const capture = vi.fn<Capturer>(async () => answer);
  return {
    capture,
    io: {
      capture,
      cwd: "/repo",
      env: repository ? { GITHUB_REPOSITORY: repository } : {},
    } as unknown as Io,
  };
}

const answering = (nodes: unknown[]) => ({
  code: 0,
  stdout: JSON.stringify({ data: { repository: { deployments: { nodes } } } }),
});

describe("stagingBuilds", () => {
  it("lists the staging deployments that passed, newest first, each commit once", async () => {
    const { io: fake, capture } = io(
      answering([
        deployment("b", "SUCCESS", "2026-10-26T12:00:00Z"),
        deployment("c", "FAILURE", "2026-10-26T13:00:00Z"),
        deployment("a", "SUCCESS", "2026-10-25T12:00:00Z"),
        deployment("b", "SUCCESS", "2026-10-26T11:00:00Z"),
      ]),
    );
    expect(await stagingBuilds(fake)).toEqual([
      { sha: sha("b"), subject: "change b", passedAt: "2026-10-26T12:00:00Z" },
      { sha: sha("a"), subject: "change a", passedAt: "2026-10-25T12:00:00Z" },
    ]);
    expect(capture).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining([
        "api",
        "graphql",
        "-F",
        "owner=acme",
        "-F",
        "name=app",
      ]),
      expect.objectContaining({ quiet: true }),
    );
  });

  it("leaves out a commit whose latest staging deployment failed", async () => {
    const { io: fake } = io(
      answering([
        deployment("b", "FAILURE", "2026-10-26T13:00:00Z"),
        deployment("b", "SUCCESS", "2026-10-26T12:00:00Z"),
        deployment("a", "SUCCESS", "2026-10-25T12:00:00Z"),
      ]),
    );
    expect(await stagingBuilds(fake)).toEqual([
      expect.objectContaining({ sha: sha("a") }),
    ]);
  });

  it("finds an empty list when nothing passed", async () => {
    const { io: fake } = io(answering([]));
    expect(await stagingBuilds(fake)).toEqual([]);
  });

  it("reports why gh failed", async () => {
    const { io: fake } = io({
      code: 1,
      stdout: "",
      stderr: "gh: Resource not accessible by integration\n",
    });
    expect(await stagingBuilds(fake)).toEqual({
      error: "gh: Resource not accessible by integration",
    });
  });

  it("asks gh for the repository when GITHUB_REPOSITORY is not set", async () => {
    const capture = vi.fn<Capturer>(async (_command, args) =>
      args[0] === "repo"
        ? { code: 0, stdout: "acme/app\n" }
        : answering([deployment("a", "SUCCESS", "2026-10-25T12:00:00Z")]),
    );
    const fake = { capture, cwd: "/repo", env: {} } as unknown as Io;
    expect(await stagingBuilds(fake)).toHaveLength(1);
  });
});

describe("commitOf", () => {
  it("reads the commit's subject and date from the contents API", async () => {
    const { io: fake, capture } = io({
      code: 0,
      stdout: JSON.stringify({
        subject: "fix: older",
        committedAt: "2026-10-01T09:00:00Z",
      }),
    });
    expect(await commitOf(fake, sha("a"))).toEqual({
      subject: "fix: older",
      committedAt: "2026-10-01T09:00:00Z",
    });
    expect(capture).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining([`repos/acme/app/commits/${sha("a")}`]),
      expect.anything(),
    );
  });

  it("asks nothing for an ID that is not a full SHA, and gives up when gh fails", async () => {
    const { io: fake, capture } = io({ code: 1, stdout: "" });
    expect(await commitOf(fake, "main")).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
    expect(await commitOf(fake, sha("a"))).toBeUndefined();
  });
});

describe("describePromotion", () => {
  const builds: StagingBuild[] = [
    { sha: sha("b"), subject: "change b", passedAt: "2026-10-26T12:00:00Z" },
    { sha: sha("a"), subject: "change a", passedAt: "2026-10-25T12:00:00Z" },
  ];

  it("names the newest build without an ID", () => {
    expect(describePromotion(builds)).toBe(
      `The newest build is \`${sha("b")}\` (change b), which passed staging at 2026-10-26T12:00:00Z. A run without a build ID promotes it where production has a required reviewer, and otherwise stops and asks for its ID.`,
    );
  });

  it("calls an older build a rollback and names the newest", () => {
    expect(describePromotion(builds, sha("a"))).toBe(
      `Promoting \`${sha("a")}\` (change a), which passed staging at 2026-10-25T12:00:00Z. This is a rollback: the newest build is \`${sha("b")}\` (change b), which passed staging at 2026-10-26T12:00:00Z.`,
    );
    expect(describePromotion(builds, sha("b"))).not.toContain("rollback");
  });

  it("leaves the decision to the build records when GitHub lists nothing", () => {
    expect(
      describePromotion(builds, sha("f"), {
        subject: "fix: long ago",
        committedAt: "2026-09-01T09:00:00Z",
      }),
    ).toContain(
      `Promoting \`${sha("f")}\` (fix: long ago), committed at 2026-09-01T09:00:00Z. GitHub lists no passing staging deployment for it among the latest ones.`,
    );
    expect(describePromotion(builds, sha("f"))).toContain(
      `GitHub lists no passing staging deployment for \`${sha("f")}\``,
    );
    expect(describePromotion([])).toContain(
      "GitHub lists no staging deployment that passed",
    );
    expect(
      describePromotion({ error: "HTTP 403" }, sha("a"), {
        subject: "fix: older",
        committedAt: "2026-10-01T09:00:00Z",
      }),
    ).toBe(
      `Promoting \`${sha("a")}\` (fix: older), committed at 2026-10-01T09:00:00Z. GitHub did not list the staging deployments (HTTP 403), so this summary cannot say whether a newer build passed. The production job checks the build records.`,
    );
    expect(describePromotion({ error: "HTTP 403" })).toBe(
      "Cannot list the staging deployments (HTTP 403). The production job checks the build records.",
    );
  });
});
