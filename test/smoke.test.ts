import { describe, expect, it, vi } from "vitest";
import { checkBuildId, judge } from "../src/smoke.js";

const url = "https://staging.acme.example.com/api/health";

describe("judge", () => {
  it("passes when the service reports the deployed build", () => {
    expect(judge(url, "abc", { status: 200, buildId: "abc" })).toEqual({
      ok: true,
      message: `${url} reports build abc`,
    });
  });

  it("fails on a mismatch and names both build IDs", () => {
    expect(judge(url, "abc", { status: 200, buildId: "old" })).toEqual({
      ok: false,
      message: `${url} reports build old, expected abc`,
    });
  });

  it("fails when the service is unreachable", () => {
    expect(judge(url, "abc", { error: "getaddrinfo ENOTFOUND" })).toEqual({
      ok: false,
      message: `${url} unreachable: getaddrinfo ENOTFOUND`,
    });
  });

  it("fails on an HTTP error status", () => {
    expect(judge(url, "abc", { status: 502, buildId: undefined })).toEqual({
      ok: false,
      message: `${url} answered HTTP 502`,
    });
  });
});

describe("checkBuildId", () => {
  const read = async (response: Response) => (await response.text()).trim();
  const sleep = vi.fn(async () => {});

  it("retries until the new build answers", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce(new Response("old"))
      .mockResolvedValueOnce(new Response("abc\n"));
    const result = await checkBuildId({ url, read }, "abc", { fetch, sleep });
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reports the last observation after the final attempt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("old"),
    );
    const result = await checkBuildId(
      { url, read },
      "abc",
      { fetch, sleep },
      { attempts: 3 },
    );
    expect(result).toEqual({
      ok: false,
      message: `${url} reports build old, expected abc`,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
