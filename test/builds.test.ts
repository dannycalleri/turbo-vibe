import { describe, expect, it, vi } from "vitest";
import {
  type BuildRecord,
  BuildStore,
  choosePromotion,
} from "../src/builds.js";
import type { Io } from "../src/io.js";

const build = (
  buildId: string,
  createdAt: string,
  smoke: BuildRecord["smoke"],
): BuildRecord => ({
  buildId,
  createdAt,
  smoke,
  services: {},
});

describe("choosePromotion", () => {
  it("chooses nothing when no build passed", () => {
    expect(
      choosePromotion([
        build("a", "2026-10-01T00:00:00Z", "failed"),
        build("b", "2026-10-02T00:00:00Z", "pending"),
      ]),
    ).toBeUndefined();
  });

  it("skips newer failed or unchecked builds for the latest that passed", () => {
    expect(
      choosePromotion([
        build("old", "2026-10-01T00:00:00Z", "passed"),
        build("good", "2026-10-02T00:00:00Z", "passed"),
        build("broken", "2026-10-03T00:00:00Z", "failed"),
        build("running", "2026-10-04T00:00:00Z", "pending"),
      ])?.buildId,
    ).toBe("good");
  });
});

describe("BuildStore", () => {
  it("follows the bucket listing's continuation token and reads every record", async () => {
    const records: Record<string, BuildRecord> = {
      a: build("a", "2026-10-01T00:00:00Z", "passed"),
      b: build("b", "2026-10-02T00:00:00Z", "failed"),
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL((input as Request).url);
      if (url.searchParams.get("list-type") === "2") {
        return new Response(
          url.searchParams.get("continuation-token") === "page2"
            ? "<ListBucketResult><Contents><Key>acme/builds/b.json</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>"
            : "<ListBucketResult><Contents><Key>acme/builds/a.json</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>page2</NextContinuationToken></ListBucketResult>",
        );
      }
      const id = url.pathname.match(/\/acme\/builds\/(\w+)\.json$/)?.[1];
      return id && records[id]
        ? Response.json(records[id])
        : new Response("", { status: 404 });
    });
    const io = {
      fetch,
      env: {
        CLOUDFLARE_ACCOUNT_ID: "acc123",
        TURBO_VIBE_STATE_BUCKET: "tv-state",
        AWS_ACCESS_KEY_ID: "id",
        AWS_SECRET_ACCESS_KEY: "secret",
      },
    } as unknown as Io;

    expect(await new BuildStore(io, "acme").listRecords()).toEqual([
      records.a,
      records.b,
    ]);
    const [first] = fetch.mock.calls;
    const listing = new URL((first?.[0] as Request | undefined)?.url ?? "");
    expect(listing.origin + listing.pathname).toBe(
      "https://acc123.r2.cloudflarestorage.com/tv-state/",
    );
    expect(listing.searchParams.get("prefix")).toBe("acme/builds/");
  });

  it("names the failing call when the bucket refuses a request", async () => {
    const io = {
      fetch: async () => new Response("", { status: 403 }),
      env: {
        CLOUDFLARE_ACCOUNT_ID: "acc123",
        TURBO_VIBE_STATE_BUCKET: "tv-state",
      },
    } as unknown as Io;
    await expect(new BuildStore(io, "acme").listRecords()).rejects.toThrow(
      "cannot list build records: the state bucket answered HTTP 403",
    );
  });
});
