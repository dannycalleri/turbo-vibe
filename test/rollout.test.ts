import { describe, expect, it, vi } from "vitest";
import { awaitRollout } from "../src/adapters/rollout.js";
import type { Io } from "../src/io.js";

const name = "acme-api-staging-backend";
const apps = `https://api.cloudflare.com/client/v4/accounts/acc123/containers/applications`;

type Rollout = {
  status: string;
  target_version: number;
  progress?: { updated_instances: number; total_instances: number };
};

function progressing(updated: number, total = 3): Rollout {
  return {
    status: "progressing",
    target_version: 7,
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
  const sleep = vi.fn(async (_ms: number) => {});
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (failed < failures) {
      failed++;
      throw new TypeError("fetch failed");
    }
    const url = String(input);
    if (url === `${apps}?name=${name}`)
      return Response.json({
        result: application ? [{ id: "app1", name, version: 7 }] : [],
      });
    if (url === `${apps}/app1/rollouts`)
      return Response.json({ result: rollouts(polls++) });
    return new Response("unexpected", { status: 404 });
  });
  const io = {
    env: { CLOUDFLARE_ACCOUNT_ID: "acc123", CLOUDFLARE_API_TOKEN: "t0ken" },
    fetch,
    sleep,
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  } as unknown as Io;
  return {
    run: () => awaitRollout(name, io),
    out: () => stdout,
    err: () => stderr,
    polls: () => polls,
    fetch,
  };
}

describe("awaitRollout", () => {
  it("returns at once when the deploy started no rollout, as a first deploy does", async () => {
    const h = harness(() => [{ status: "completed", target_version: 6 }]);
    expect(await h.run()).toBe(0);
    expect(h.out()).toBe("");
  });

  it("reports progress once per change and returns when every instance runs the new image", async () => {
    const h = harness((poll) =>
      poll < 2
        ? [progressing(0)]
        : poll < 4
          ? [progressing(2)]
          : [{ status: "completed", target_version: 7 }],
    );
    expect(await h.run()).toBe(0);
    expect(h.out()).toBe(
      `${name}: 0/3 instances on the new image\n${name}: 2/3 instances on the new image\n${name}: every instance runs the new image\n`,
    );
    expect(h.fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: "Bearer t0ken" },
    });
  });

  it.each([
    ["replaced", `the rollout of ${name} was replaced by a newer deploy\n`],
    [
      "reverted",
      `Cloudflare reverted the rollout of ${name} to the previous image\n`,
    ],
  ])("stops at once when the rollout is %s", async (status, message) => {
    const h = harness(() => [{ status, target_version: 7 }]);
    expect(await h.run()).toBe(1);
    expect(h.err()).toBe(message);
    expect(h.polls()).toBe(1);
  });

  it("names SIGTERM after 90 seconds and gives up after 17 minutes", async () => {
    const h = harness(() => [progressing(2)]);
    expect(await h.run()).toBe(1);
    expect(h.out().match(/ignores SIGTERM/g)).toHaveLength(1);
    expect(h.err()).toBe(
      `the rollout of ${name} did not finish within 17 minutes (2/3 instances on the new image); the new Worker is live, and requests can still reach the previous image\n`,
    );
    expect(h.polls()).toBe((17 * 60) / 5 + 1);
  });

  it("rides out a few failed requests", async () => {
    const h = harness(() => [{ status: "completed", target_version: 7 }], {
      failures: 3,
    });
    expect(await h.run()).toBe(0);
  });

  it("fails when Cloudflare stays unreachable", async () => {
    const h = harness(() => [], { failures: 100 });
    expect(await h.run()).toBe(1);
    expect(h.err()).toBe(
      `cannot find container application ${name} to follow its rollout\n`,
    );
  });

  it("fails when the application does not exist", async () => {
    const h = harness(() => [], { application: false });
    expect(await h.run()).toBe(1);
    expect(h.err()).toBe(
      `cannot find container application ${name} to follow its rollout\n`,
    );
  });
});
