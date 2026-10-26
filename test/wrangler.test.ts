import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  healthModule,
  routingModule,
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

  const answering = (status: number) => {
    const requests: string[] = [];
    return {
      requests,
      fetch: async (request: Request) => {
        requests.push(request.url);
        return new Response(status === 204 ? null : "body", { status });
      },
    };
  };

  async function probe(
    status: number,
    path = "/",
    strict = false,
  ): Promise<{ status: number; body: unknown; requests: string[] }> {
    const container = answering(status);
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

  it("answers 503 and names the status when / answers 500", async () => {
    expect(await probe(500)).toMatchObject({
      status: 503,
      body: { error: "/ answered HTTP 500" },
    });
  });

  it("accepts only 2xx from a configured path", async () => {
    expect(await probe(204, "/ready", true)).toMatchObject({
      status: 200,
      requests: ["https://staging.acme.example.com/ready"],
    });
    expect(await probe(404, "/ready", true)).toMatchObject({
      status: 503,
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
