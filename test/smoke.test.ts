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

  it("names the reason a service gives with its error status", () => {
    expect(
      judge(url, "abc", {
        status: 503,
        buildId: undefined,
        reason: "/ answered HTTP 500",
      }),
    ).toEqual({
      ok: false,
      message: `${url} answered HTTP 503: / answered HTTP 500`,
    });
  });

  it("fails on an HTTP error status", () => {
    expect(judge(url, "abc", { status: 502, buildId: undefined })).toEqual({
      ok: false,
      message: `${url} answered HTTP 502`,
    });
  });
  it("says where the reason is when a private environment's Worker keeps it out of the answer", () => {
    expect(
      judge(
        url,
        "abc",
        { status: 502, buildId: undefined },
        "read it in the Worker's logs",
      ),
    ).toEqual({
      ok: false,
      message: `${url} answered HTTP 502: read it in the Worker's logs`,
    });
    expect(
      judge(
        url,
        "abc",
        { status: 502, buildId: undefined, reason: "/ answered HTTP 500" },
        "read it in the Worker's logs",
      ).message,
    ).toBe(`${url} answered HTTP 502: / answered HTTP 500`);
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

  it("waits longer while the service answers 503, as a starting container does", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (let i = 0; i < 6; i++)
      fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
    fetch.mockResolvedValueOnce(new Response("abc"));
    const result = await checkBuildId(
      { url, read },
      "abc",
      { fetch, sleep },
      { attempts: 3, switchingAttempts: 10 },
    );
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("gives up after the usual attempts on any other failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("", { status: 500 }),
    );
    const result = await checkBuildId(
      { url, read },
      "abc",
      { fetch, sleep },
      { attempts: 3, switchingAttempts: 10 },
    );
    expect(result).toEqual({ ok: false, message: `${url} answered HTTP 500` });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops at the longer allowance when the service never starts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("", { status: 503 }),
    );
    const result = await checkBuildId(
      { url, read },
      "abc",
      { fetch, sleep },
      { attempts: 3, switchingAttempts: 10 },
    );
    expect(result).toEqual({ ok: false, message: `${url} answered HTTP 503` });
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it("waits longer while the service still reports the previous build", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (let i = 0; i < 6; i++)
      fetch.mockResolvedValueOnce(new Response("old"));
    fetch.mockResolvedValueOnce(new Response("abc"));
    const result = await checkBuildId(
      { url, read },
      "abc",
      { fetch, sleep },
      { attempts: 3, switchingAttempts: 10 },
    );
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("gives up after the usual attempts when the service reports no build", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("{}"),
    );
    const result = await checkBuildId(
      { url, read: async () => undefined },
      "abc",
      { fetch, sleep },
      { attempts: 3, switchingAttempts: 10 },
    );
    expect(result).toEqual({
      ok: false,
      message: `${url} reports build (none), expected abc`,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
