import { describe, expect, it, vi } from "vitest";
import type { Io } from "../src/io.js";
import type { Capturer } from "../src/run.js";
import {
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

describe("describePromotion", () => {
  const builds: StagingBuild[] = [
    { sha: sha("b"), subject: "change b", passedAt: "2026-10-26T12:00:00Z" },
    { sha: sha("a"), subject: "change a", passedAt: "2026-10-25T12:00:00Z" },
  ];

  it("names the newest build without an ID", () => {
    expect(describePromotion(builds)).toBe(
      `Promoting the newest build: \`${sha("b")}\` (change b), which passed staging at 2026-10-26T12:00:00Z.`,
    );
  });

  it("calls an older build a rollback and names the newest", () => {
    expect(describePromotion(builds, sha("a"))).toBe(
      `Promoting \`${sha("a")}\` (change a), which passed staging at 2026-10-25T12:00:00Z. This is a rollback: the newest build is \`${sha("b")}\` (change b), which passed staging at 2026-10-26T12:00:00Z.`,
    );
    expect(describePromotion(builds, sha("b"))).not.toContain("rollback");
  });

  it("leaves the decision to the build records when GitHub lists nothing", () => {
    expect(describePromotion(builds, sha("f"))).toContain(
      `GitHub lists no passing staging deployment for \`${sha("f")}\``,
    );
    expect(describePromotion([])).toContain(
      "GitHub lists no staging deployment that passed",
    );
    expect(describePromotion({ error: "HTTP 403" })).toBe(
      "Cannot list the staging deployments (HTTP 403). The production job checks the build records.",
    );
  });
});
