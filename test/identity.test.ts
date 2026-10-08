import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { callbackUrl } from "../src/adapters/workos.js";
import { parseConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";
import { listRedirectUris, redirectUriPlan } from "../src/identity.js";
import type { Io } from "../src/io.js";

const staging = "https://staging.acme.example.com/api/auth/callback";

describe("redirectUriPlan", () => {
  it("creates the callback when WorkOS does not have it", () => {
    expect(
      redirectUriPlan({ desired: [staging], existing: [], managed: [] }),
    ).toEqual({
      manage: [staging],
      alreadyRegistered: [],
    });
  });

  it("counts a callback someone already registered as registered, and leaves it out of OpenTofu", () => {
    expect(
      redirectUriPlan({ desired: [staging], existing: [staging], managed: [] }),
    ).toEqual({
      manage: [],
      alreadyRegistered: [staging],
    });
  });

  it("keeps managing a callback the kit created", () => {
    expect(
      redirectUriPlan({
        desired: [staging],
        existing: [staging],
        managed: [staging],
      }),
    ).toEqual({ manage: [staging], alreadyRegistered: [] });
  });

  it("never hands OpenTofu a URI the kit did not create, so it is never removed", () => {
    const other = "https://localhost:3000/callback";
    const plan = redirectUriPlan({
      desired: [staging],
      existing: [other],
      managed: [],
    });
    expect(plan.manage).not.toContain(other);
    expect(plan.alreadyRegistered).not.toContain(other);
  });
});

describe("callbackUrl", () => {
  function config(identity: string): Config {
    const result = parseConfig(
      `version: 1\nproject: acme\ndomain: acme.example.com\nservices:\n  auth:\n    kind: identity\n    target: workos\n${identity}`,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.config;
  }

  it("is the backend's auth callback on each environment's hostname", () => {
    expect(callbackUrl(config(""), "staging")).toBe(staging);
    expect(callbackUrl(config(""), "production")).toBe(
      "https://acme.example.com/api/auth/callback",
    );
  });

  it("uses a configured callback path", () => {
    expect(
      callbackUrl(config("    callback_path: /api/sso/done\n"), "staging"),
    ).toBe("https://staging.acme.example.com/api/sso/done");
  });
});

describe("listRedirectUris against a recorded fake of /user_management/redirect_uris", () => {
  const pages: Record<
    string,
    { data: { uri: string }[]; list_metadata: { after: string | null } }
  > = {
    first: {
      data: [{ uri: "https://localhost:3000/callback" }, { uri: staging }],
      list_metadata: { after: "redir_02" },
    },
    redir_02: {
      data: [{ uri: "https://acme.example.com/api/auth/callback" }],
      list_metadata: { after: null },
    },
  };
  const authorizations: (string | null)[] = [];
  const server = setupServer(
    http.get(
      "https://api.workos.com/user_management/redirect_uris",
      ({ request }) => {
        authorizations.push(request.headers.get("authorization"));
        const after = new URL(request.url).searchParams.get("after");
        return HttpResponse.json({
          object: "list",
          ...pages[after ?? "first"],
        });
      },
    ),
  );
  const io = {
    env: { WORKOS_API_KEY: "sk_test_123" },
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  } as unknown as Io;

  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it("follows the pagination cursor and authenticates with the environment's key", async () => {
    expect(await listRedirectUris(io)).toEqual([
      "https://localhost:3000/callback",
      staging,
      "https://acme.example.com/api/auth/callback",
    ]);
    expect(
      authorizations.every((value) => value === "Bearer sk_test_123"),
    ).toBe(true);
  });

  it("fails loudly when WorkOS rejects the key", async () => {
    server.use(
      http.get("https://api.workos.com/user_management/redirect_uris", () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    );
    await expect(listRedirectUris(io)).rejects.toThrow(
      "WorkOS answered HTTP 401 listing redirect URIs",
    );
  });
});
