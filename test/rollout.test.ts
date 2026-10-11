import { describe, expect, it, vi } from "vitest";
import { awaitRollout, existingRollouts } from "../src/adapters/rollout.js";
import type { Io } from "../src/io.js";

const name = "acme-api-staging-backend";
const apps = `https://api.cloudflare.com/client/v4/accounts/acc123/containers/applications`;
const before = new Set(["old"]);
const old = {
  id: "old",
  status: "completed",
  created_at: "2026-10-11T09:00:00Z",
};

type Rollout = {
  id: string;
  status: string;
  created_at: string;
  progress?: { updated_instances: number; total_instances: number };
};

function ours(status: string, updated = 0, total = 3): Rollout {
  return {
    id: "new",
    status,
    created_at: "2026-10-11T10:00:00Z",
    progress: { updated_instances: updated, total_instances: total },
  };
}

function harness(
  rollouts: (poll: number) => Rollout[],
  { application = true, failures = 0 } = {},
) {
  let polls = 0;
  let failed = 0;
  let stdout = "";
  let stderr = "";
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (failed < failures) {
      failed++;
      throw new TypeError("fetch failed");
    }
    const url = String(input);
    if (url === `${apps}?name=${name}`)
      // The application's version lags behind the rollout a deploy starts, so nothing may rely on it.
      return Response.json({
        result: application ? [{ id: "app1", name, version: 1 }] : [],
      });
    if (url === `${apps}/app1/rollouts`)
      return Response.json({ result: rollouts(polls++) });
    return new Response("unexpected", { status: 404 });
  });
  const io = {
    env: { CLOUDFLARE_ACCOUNT_ID: "acc123", CLOUDFLARE_API_TOKEN: "t0ken" },
    fetch,
    sleep: async () => {},
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  } as unknown as Io;
  return {
    io,
    await: () => awaitRollout(name, before, io),
    out: () => stdout,
    err: () => stderr,
    polls: () => polls,
    fetch,
  };
}

describe("existingRollouts", () => {
  it("is empty before a first deploy, when the application does not exist yet", async () => {
    const h = harness(() => [], { application: false });
    expect(await existingRollouts(name, h.io)).toEqual(new Set());
  });

  it("lists the rollouts already there", async () => {
    const h = harness(() => [old]);
    expect(await existingRollouts(name, h.io)).toEqual(new Set(["old"]));
    expect(h.fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: "Bearer t0ken" },
    });
  });

  it("refuses to deploy when Cloudflare does not answer, since the wait could not tell its rollout apart", async () => {
    const h = harness(() => [], { failures: 100 });
    expect(await existingRollouts(name, h.io)).toBeUndefined();
    expect(h.err()).toBe(
      `cannot read the rollouts of ${name} before deploying\n`,
    );
  });
});

describe("awaitRollout", () => {
  it("returns at once when the deploy started no rollout, as a first deploy does", async () => {
    const h = harness(() => [old]);
    expect(await h.await()).toBe(0);
    expect(h.out()).toBe(
      `${name}: no rollout started, so no instance to replace\n`,
    );
  });

  it("follows the rollout the deploy started, reporting progress once per change", async () => {
    const h = harness((poll) => [
      poll < 2
        ? ours("progressing", 0)
        : poll < 4
          ? ours("progressing", 2)
          : ours("completed", 3),
      old,
    ]);
    expect(await h.await()).toBe(0);
    expect(h.out()).toBe(
      `${name}: 0/3 instances on the new image\n${name}: 2/3 instances on the new image\n${name}: every instance runs the new image\n`,
    );
  });

  it.each([
    ["replaced", `the rollout of ${name} was replaced by a newer deploy\n`],
    [
      "reverted",
      `Cloudflare reverted the rollout of ${name} to the previous image\n`,
    ],
  ])("stops at once when the rollout is %s", async (status, message) => {
    const h = harness(() => [ours(status), old]);
    expect(await h.await()).toBe(1);
    expect(h.err()).toBe(message);
    expect(h.polls()).toBe(1);
  });

  it("names SIGTERM after 90 seconds and gives up after 17 minutes", async () => {
    const h = harness(() => [ours("progressing", 2), old]);
    expect(await h.await()).toBe(1);
    expect(h.out().match(/ignores SIGTERM/g)).toHaveLength(1);
    expect(h.err()).toBe(
      `the rollout of ${name} did not finish within 17 minutes (2/3 instances on the new image); the new Worker is live, and requests can still reach the previous image\n`,
    );
    expect(h.polls()).toBe((17 * 60) / 5 + 1);
  });

  it("rides out a few failed requests", async () => {
    const h = harness(() => [ours("completed", 3)], { failures: 3 });
    expect(await h.await()).toBe(0);
  });

  it("fails when Cloudflare stays unreachable", async () => {
    const h = harness(() => [], { failures: 100 });
    expect(await h.await()).toBe(1);
    expect(h.err()).toBe(
      `cannot find container application ${name} to follow its rollout\n`,
    );
  });

  it("fails when the application does not exist after deploying", async () => {
    const h = harness(() => [], { application: false });
    expect(await h.await()).toBe(1);
    expect(h.err()).toBe(
      `cannot find container application ${name} to follow its rollout\n`,
    );
  });
});
