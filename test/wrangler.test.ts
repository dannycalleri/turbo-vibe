import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  healthModule,
  routingModule,
  signInModule,
  workerEntry,
  wranglerConfig,
} from "../src/adapters/wrangler.js";

const backend = {
  kind: "backend" as const,
  target: "cloudflare-container",
  build: { dockerfile: "api/Dockerfile" },
};

describe("wranglerConfig", () => {
  it("binds the container with the default instance type and serves assets except /api/*", () => {
    const config = wranglerConfig({
      name: "acme-api-staging",
      buildId: "abc",
      configDir: "/repo",
      backend,
      port: 8080,
      assets: "/repo/web/dist",
    });
    expect(config).toMatchObject({
      name: "acme-api-staging",
      main: "worker.js",
      workers_dev: false,
      observability: { enabled: true },
      containers: [
        {
          class_name: "Backend",
          image: "/repo/api/Dockerfile",
          image_build_context: "/repo/api",
          image_vars: { TURBO_VIBE_BUILD_ID: "abc", BUILD_ID: "abc" },
          instance_type: "lite",
        },
      ],
      durable_objects: {
        bindings: [{ name: "BACKEND", class_name: "Backend" }],
      },
      assets: {
        directory: "/repo/web/dist",
        run_worker_first: ["/api/*", "/_turbo-vibe/health"],
      },
    });
    expect(config).not.toHaveProperty("routes");
    expect(config).not.toHaveProperty("vars");
  });

  it("uses the configured instance type and build context", () => {
    const config = wranglerConfig({
      name: "w",
      buildId: "abc",
      configDir: "/repo",
      backend: {
        ...backend,
        build: { dockerfile: "api/Dockerfile", context: "." },
        container: { instance_type: "standard-1" },
      },
      port: 8080,
    });
    expect(config).toMatchObject({
      containers: [
        { image_build_context: "/repo", instance_type: "standard-1" },
      ],
    });
    expect(config).not.toHaveProperty("assets");
  });

  it("makes a standalone frontend an assets-only Worker", () => {
    expect(
      wranglerConfig({
        name: "acme-web-staging",
        buildId: "abc",
        configDir: "/repo",
        assets: "/repo/dist",
      }),
    ).toEqual({
      name: "acme-web-staging",
      compatibility_date: expect.any(String),
      workers_dev: false,
      preview_urls: false,
      observability: { enabled: true },
      assets: {
        directory: "/repo/dist",
        not_found_handling: "single-page-application",
      },
    });
  });

  it("answers a missing page as the frontend asks: the nearest 404.html or index.html, with /api/ kept on the backend", () => {
    expect(
      wranglerConfig({
        name: "acme-web-staging",
        buildId: "abc",
        configDir: "/repo",
        assets: "/repo/dist",
        notFound: "404-page",
      }).assets,
    ).toEqual({ directory: "/repo/dist", not_found_handling: "404-page" });
    expect(
      wranglerConfig({
        name: "acme-web-staging",
        buildId: "abc",
        configDir: "/repo",
        assets: "/repo/dist",
        notFound: "spa",
      }).assets,
    ).toEqual({
      directory: "/repo/dist",
      not_found_handling: "single-page-application",
    });
    expect(
      wranglerConfig({
        name: "acme-api-staging",
        buildId: "abc",
        configDir: "/repo",
        backend,
        port: 8080,
        assets: "/repo/web/dist",
        notFound: "404-page",
      }).assets,
    ).toEqual({
      directory: "/repo/web/dist",
      not_found_handling: "404-page",
      run_worker_first: ["/api/*", "/_turbo-vibe/health"],
    });
  });
});

describe("run_worker_first", () => {
  it("sends each of the backend's paths and the health path to the Worker before the frontend's files", () => {
    expect(
      wranglerConfig({
        name: "w",
        buildId: "b",
        configDir: "/repo",
        backend: { ...backend, paths: ["/api/", "/auth/"] },
        port: 8080,
        assets: "/repo/dist",
      }).assets,
    ).toMatchObject({
      run_worker_first: ["/api/*", "/auth/*", "/_turbo-vibe/health"],
    });
  });
});

describe("workerEntry", () => {
  const buildId = "abc1230000000000000000000000000000000000";

  it("forwards every request, WebSocket upgrades included, with fetch", () => {
    const entry = workerEntry(backend, 8080, buildId);
    expect(entry).toContain(
      "return getContainer(env.BACKEND, instanceName(request)).fetch(request);",
    );
    expect(entry).not.toContain("containerFetch");
  });

  it("gives the container its port, the build ID and the named secrets", () => {
    expect(workerEntry(backend, 8080, buildId, ["DATABASE_URL"])).toContain(
      `this.envVars = { PORT: "8080", TURBO_VIBE_BUILD_ID: "${buildId}", DATABASE_URL: env.DATABASE_URL };`,
    );
    expect(workerEntry(backend, 8080, buildId)).not.toMatch(/[^_]BUILD_ID:/);
  });

  it("sends requests to the backend's port and gives it as PORT", () => {
    const entry = workerEntry(backend, 3000, buildId);
    expect(entry).toContain("defaultPort = 3000;");
    expect(entry).toContain('PORT: "3000"');
  });

  it("answers its health path by probing / leniently, or the configured path strictly", () => {
    expect(workerEntry(backend, 8080, buildId)).toContain(
      `return health(getContainer(env.BACKEND, instanceName(plain)), request.url, "/", false, "${buildId}");`,
    );
    expect(
      workerEntry(
        { ...backend, container: { health: "/ready" } },
        8080,
        buildId,
      ),
    ).toContain(`request.url, "/ready", true, "${buildId}")`);
  });

  it("probes the instance a request without a session reaches, whatever the health request carries", async () => {
    const entry = workerEntry(
      { ...backend, container: { instance_from: "query:session" } },
      8080,
      buildId,
    );
    const branch = entry.slice(entry.indexOf("/_turbo-vibe/health"));
    expect(branch).toContain(
      'const plain = new Request(new URL("/", request.url));',
    );
    expect(
      branch.slice(0, branch.indexOf("return getContainer")),
    ).not.toContain("instanceName(request)");
    const { instanceName } = await import(
      `data:text/javascript,${encodeURIComponent(routingModule({ ...backend, container: { instance_from: "query:session" } }, buildId))}`
    );
    const plain = new Request(
      new URL("/", "https://a.example/_turbo-vibe/health?session=x"),
    );
    expect(instanceName(plain)).toBe("default@abc123000000");
  });

  it("answers the sign-in path only when it is given the page's origins", () => {
    expect(workerEntry(backend, 8080, buildId)).not.toContain("sign-in");
    const entry = workerEntry(
      backend,
      8080,
      buildId,
      [],
      ["https://staging.example.com"],
    );
    expect(entry).toContain('import { signIn } from "./sign-in.js";');
    expect(entry).toContain(
      'return signIn(request, ["https://staging.example.com"]);',
    );
  });

  it("sleeps after the configured idle time, five minutes by default", () => {
    expect(workerEntry(backend, 8080, buildId)).toContain('sleepAfter = "5m"');
    expect(
      workerEntry(
        { ...backend, container: { sleep_after: "30s" } },
        8080,
        buildId,
      ),
    ).toContain('sleepAfter = "30s"');
  });
});

describe("the generated health module", () => {
  type Health = (
    container: { fetch: (request: Request) => Promise<Response> },
    url: string,
    path: string,
    strict: boolean,
    buildId: string,
  ) => Promise<Response>;

  async function load(): Promise<Health> {
    const module = await import(
      `data:text/javascript,${encodeURIComponent(healthModule)}`
    );
    return module.health;
  }

  const answering = (status: number, body = "body", type = "text/plain") => {
    const requests: string[] = [];
    return {
      requests,
      fetch: async (request: Request) => {
        requests.push(request.url);
        return new Response(status === 204 ? null : body, {
          status,
          headers: { "content-type": type },
        });
      },
    };
  };

  async function probe(
    status: number,
    path = "/",
    strict = false,
    body?: string,
    type?: string,
  ): Promise<{ status: number; body: unknown; requests: string[] }> {
    const container = answering(status, body, type);
    const response = await (await load())(
      container,
      "https://staging.acme.example.com/_turbo-vibe/health",
      path,
      strict,
      "abc123",
    );
    return {
      status: response.status,
      body: await response.json(),
      requests: container.requests,
    };
  }

  it("reports the build when the server answers / with a 404", async () => {
    expect(await probe(404)).toEqual({
      status: 200,
      body: { build_id: "abc123" },
      requests: ["https://staging.acme.example.com/"],
    });
  });

  it("answers 502, a plain failure, and names the status when / answers 500", async () => {
    expect(await probe(500)).toMatchObject({
      status: 502,
      body: { error: "/ answered HTTP 500" },
    });
  });

  it("answers 503 while the container reports another build, and passes once it reports this one", async () => {
    expect(
      await probe(
        200,
        "/api/health",
        true,
        JSON.stringify({ build_id: "old999" }),
        "application/json",
      ),
    ).toMatchObject({
      status: 503,
      body: { error: "/api/health reports build old999" },
    });
    expect(
      await probe(
        200,
        "/api/health",
        true,
        JSON.stringify({ build_id: "abc123" }),
        "application/json",
      ),
    ).toMatchObject({ status: 200, body: { build_id: "abc123" } });
  });

  it("reads the body only when it is JSON", async () => {
    const stream = new ReadableStream({ pull() {} });
    const response = await (await load())(
      {
        fetch: async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      },
      "https://staging.acme.example.com/_turbo-vibe/health",
      "/",
      false,
      "abc123",
    );
    expect(response.status).toBe(200);
    expect(
      await probe(200, "/", false, JSON.stringify({ build_id: "old999" })),
    ).toMatchObject({ status: 200 });
  });

  it("accepts only 2xx from a configured path", async () => {
    expect(await probe(204, "/ready", true)).toMatchObject({
      status: 200,
      requests: ["https://staging.acme.example.com/ready"],
    });
    expect(await probe(404, "/ready", true)).toMatchObject({
      status: 502,
      body: { error: "/ready answered HTTP 404" },
    });
  });

  it("answers 503 with the error when the container cannot be reached", async () => {
    const response = await (await load())(
      {
        fetch: async () => {
          throw new Error("the container is not running");
        },
      },
      "https://staging.acme.example.com/_turbo-vibe/health",
      "/",
      false,
      "abc123",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "/: Error: the container is not running",
    });
  });
});

describe("the generated sign-in module", () => {
  const page = "https://staging.example.com";

  async function signIn(value?: string): Promise<Response> {
    const module = await import(
      `data:text/javascript,${encodeURIComponent(signInModule)}`
    );
    const url = new URL("https://api.staging.example.com/_turbo-vibe/sign-in");
    if (value !== undefined) url.searchParams.set("return", value);
    return module.signIn(new Request(url), [page]);
  }

  it("sends the person back to a page of the environment, and nothing caches the answer", async () => {
    const response = await signIn(`${page}/orders?id=7`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${page}/orders?id=7`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["another origin", "https://evil.example/"],
    ["an allowed origin followed by another domain", `${page}.evil.example/`],
    ["an allowed origin before @", `${page}@evil.example/`],
    ["a scheme-relative URL", "//evil.example/"],
    ["backslashes", "https:\\\\evil.example/"],
    ["http with an allowed host", "http://staging.example.com/"],
    ["a script", "javascript:alert(1)"],
    ["no URL at all", ""],
  ])("refuses %s", async (_case, value) => {
    const response = await signIn(value);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses a request without return", async () => {
    expect((await signIn()).status).toBe(400);
  });

  it("never lets a line break in return add a header", async () => {
    const response = await signIn(`${page}/\r\nSet-Cookie: a=b`);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBe(`${page}/Set-Cookie:%20a=b`);
  });
});

describe("routingModule", () => {
  async function instanceName(rule?: string, buildId = "abc1230000000000") {
    const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-routing-"));
    const file = join(dir, "routing.mjs");
    await writeFile(
      file,
      routingModule(
        {
          ...backend,
          ...(rule ? { container: { instance_from: rule } } : {}),
        },
        buildId,
      ),
    );
    return (
      (await import(pathToFileURL(file).href)) as {
        instanceName: (request: Request) => string;
      }
    ).instanceName;
  }

  it("routes a request to the instance its query parameter names", async () => {
    const route = await instanceName("query:session");
    expect(
      route(new Request("https://app.example.com/api/ws?session=room-7")),
    ).toBe("room-7@abc123000000");
    expect(route(new Request("https://app.example.com/api/ws"))).toBe(
      "default@abc123000000",
    );
  });

  it("gives the next build new instances, so no request reaches the old image after a deploy", async () => {
    const before = await instanceName("query:session", "aaaa1111bbbb2222");
    const after = await instanceName("query:session", "cccc3333dddd4444");
    const request = new Request("https://app.example.com/api/health");
    expect(before(request)).toBe("default@aaaa1111bbbb");
    expect(after(request)).toBe("default@cccc3333dddd");
  });

  it("routes a request to the instance its header names", async () => {
    const route = await instanceName("header:x-session");
    expect(
      route(
        new Request("https://app.example.com/api/ws", {
          headers: { "x-session": "user-42" },
        }),
      ),
    ).toBe("user-42@abc123000000");
    expect(route(new Request("https://app.example.com/api/ws"))).toBe(
      "default@abc123000000",
    );
  });

  it("sends everything to one instance named default without a rule", async () => {
    const route = await instanceName();
    expect(
      route(new Request("https://app.example.com/api/ws?session=room-7")),
    ).toBe("default");
  });
});

describe("instance limits", () => {
  const config = (container: object) =>
    wranglerConfig({
      name: "w",
      buildId: "b",
      configDir: "/repo",
      backend: { ...backend, container },
      port: 8080,
    }).containers as {
      max_instances: number;
    }[];

  it("allows one instance by default, or the configured number", () => {
    expect(config({})[0]?.max_instances).toBe(1);
    expect(
      config({ instance_from: "query:session", max_instances: 3 })[0]
        ?.max_instances,
    ).toBe(3);
  });
});
