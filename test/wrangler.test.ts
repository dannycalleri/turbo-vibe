import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
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
          image_vars: { BUILD_ID: "abc" },
          instance_type: "lite",
        },
      ],
      durable_objects: {
        bindings: [{ name: "BACKEND", class_name: "Backend" }],
      },
      assets: { directory: "/repo/web/dist", run_worker_first: ["/api/*"] },
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
      run_worker_first: ["/api/*"],
    });
  });
});

describe("workerEntry", () => {
  it("forwards every request, WebSocket upgrades included, with fetch", () => {
    const entry = workerEntry(backend, 8080);
    expect(entry).toContain(
      "getContainer(env.BACKEND, instanceName(request)).fetch(request)",
    );
    expect(entry).not.toContain("containerFetch");
  });

  it("passes the named secrets from the Worker to the container", () => {
    expect(workerEntry(backend, 8080, ["DATABASE_URL"])).toContain(
      'this.envVars = { PORT: "8080", DATABASE_URL: env.DATABASE_URL };',
    );
    expect(workerEntry(backend, 8080)).toContain(
      'this.envVars = { PORT: "8080" };',
    );
  });

  it("sends requests to the backend's port and gives it as PORT", () => {
    const entry = workerEntry(backend, 3000);
    expect(entry).toContain("defaultPort = 3000;");
    expect(entry).toContain('this.envVars = { PORT: "3000" };');
  });

  it("sleeps after the configured idle time, five minutes by default", () => {
    expect(workerEntry(backend, 8080)).toContain('sleepAfter = "5m"');
    expect(
      workerEntry({ ...backend, container: { sleep_after: "30s" } }, 8080),
    ).toContain('sleepAfter = "30s"');
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
