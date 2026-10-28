import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/schema.js";
import { backendPaths, buildIdVariable, legacyBuildArg } from "../contract.js";

type Backend = Extract<Config["services"][string], { kind: "backend" }>;

const require = createRequire(import.meta.url);
const wranglerBin = join(
  dirname(require.resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);
const containersModule = fileURLToPath(
  import.meta.resolve("@cloudflare/containers"),
);

export const compatibilityDate = "2026-10-01";
export const buildIdPath = "/_turbo-vibe/build-id";
export const kitHealthPath = "/_turbo-vibe/health";
export const runtimeConfigPath = "/_turbo-vibe/config.json";

// With several instances, Cloudflare's rollout can leave a long-lived instance on the old image for minutes after it reports completion; an instance named after the build starts on the new image, so the switch is immediate.
export function routingModule(backend: Backend, buildId: string): string {
  const rule = backend.container?.instance_from;
  const [source, name] = rule ? rule.split(":") : [];
  const read =
    source === "query"
      ? `new URL(request.url).searchParams.get(${JSON.stringify(name)})`
      : source === "header"
        ? `request.headers.get(${JSON.stringify(name)})`
        : "undefined";
  const suffix = rule ? ` + ${JSON.stringify(`@${buildId.slice(0, 12)}`)}` : "";
  return `export function instanceName(request) {
  return (${read} || "default")${suffix};
}
`;
}

export const healthModule = `export async function health(container, url, path, strict, buildId) {
  let status;
  let body;
  try {
    const response = await container.fetch(new Request(new URL(path, url)));
    status = response.status;
    if (response.headers.get("content-type")?.includes("json"))
      body = await response.text();
    else await response.body?.cancel();
  } catch (error) {
    return Response.json({ error: \`\${path}: \${error}\` }, { status: 503 });
  }
  if (!(strict ? status >= 200 && status < 300 : status < 500))
    return Response.json(
      { error: \`\${path} answered HTTP \${status}\` },
      { status: 502 },
    );
  let reported;
  try {
    reported = JSON.parse(body).build_id;
  } catch {}
  if (typeof reported === "string" && reported !== buildId)
    return Response.json(
      { error: \`\${path} reports build \${reported}\` },
      { status: 503 },
    );
  return Response.json({ build_id: buildId });
}
`;

export function workerEntry(
  backend: Backend,
  port: number,
  buildId: string,
  secretNames: readonly string[] = [],
): string {
  const sleepAfter = backend.container?.sleep_after ?? "5m";
  const probe = backend.container?.health;
  const forwarded = secretNames
    .map((name) => `, ${name}: env.${name}`)
    .join("");
  return `import { Container, getContainer } from ${JSON.stringify(containersModule)};
import { health } from "./health.js";
import { instanceName } from "./routing.js";

export class Backend extends Container {
  defaultPort = ${port};
  sleepAfter = ${JSON.stringify(sleepAfter)};

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = { PORT: "${port}", ${buildIdVariable}: ${JSON.stringify(buildId)}${forwarded} };
  }
}

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/_turbo-vibe/sign-in") {
      const target = new URL(new URL(request.url).searchParams.get("return") ?? "https://invalid");
      if (target.protocol !== "https:" || !target.hostname.endsWith(".turbovibe.ai")) return new Response("bad return", { status: 400 });
      return new Response(null, { status: 302, headers: { Location: target.href, "Cache-Control": "no-store" } });
    }
    if (new URL(request.url).pathname === ${JSON.stringify(kitHealthPath)}) {
      const plain = new Request(new URL("/", request.url));
      return health(getContainer(env.BACKEND, instanceName(plain)), request.url, ${JSON.stringify(probe ?? "/")}, ${probe !== undefined}, ${JSON.stringify(buildId)});
    }
    return getContainer(env.BACKEND, instanceName(request)).fetch(request);
  },
};
`;
}

export type WorkerSpec = {
  name: string;
  image?: string;
  secretNames?: readonly string[];
  buildId: string;
  configDir: string;
  assets?: string;
  notFound?: "spa" | "404-page";
} & ({ backend?: undefined } | { backend: Backend; port: number });

export function wranglerConfig(spec: WorkerSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: spec.name,
    compatibility_date: compatibilityDate,
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
  };
  if (spec.backend) {
    const dockerfile = resolve(spec.configDir, spec.backend.build.dockerfile);
    const container = spec.image
      ? { class_name: "Backend", image: spec.image }
      : {
          class_name: "Backend",
          image: dockerfile,
          image_build_context: spec.backend.build.context
            ? resolve(spec.configDir, spec.backend.build.context)
            : dirname(dockerfile),
          image_vars: {
            [buildIdVariable]: spec.buildId,
            [legacyBuildArg]: spec.buildId,
          },
        };
    Object.assign(config, {
      main: "worker.js",
      containers: [
        {
          ...container,
          instance_type: spec.backend.container?.instance_type ?? "lite",
          max_instances: spec.backend.container?.max_instances ?? 1,
        },
      ],
      durable_objects: {
        bindings: [{ name: "BACKEND", class_name: "Backend" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Backend"] }],
    });
  }
  if (spec.assets) {
    config.assets = {
      directory: spec.assets,
      not_found_handling:
        spec.notFound === "404-page" ? "404-page" : "single-page-application",
      ...(spec.backend
        ? {
            run_worker_first: [
              ...backendPaths(spec.backend).map((path) => `${path}*`),
              kitHealthPath,
            ],
          }
        : {}),
    };
  }
  return config;
}

export async function writeWorker(
  dir: string,
  spec: WorkerSpec,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  if (spec.backend) {
    await writeFile(
      join(dir, "worker.js"),
      workerEntry(spec.backend, spec.port, spec.buildId, spec.secretNames),
    );
    await writeFile(join(dir, "health.js"), healthModule);
    await writeFile(
      join(dir, "routing.js"),
      routingModule(spec.backend, spec.buildId),
    );
  }
  const file = join(dir, "wrangler.json");
  await writeFile(file, `${JSON.stringify(wranglerConfig(spec), null, 2)}\n`);
  return file;
}

export function wranglerPushArgs(tag: string): string[] {
  return [wranglerBin, "containers", "push", tag];
}

export function wranglerDeployArgs(
  configFile: string,
  dryRun: boolean,
  secretsFile?: string,
): string[] {
  return [
    wranglerBin,
    "deploy",
    "--config",
    configFile,
    // With max_instances above 1, wrangler's default gradual rollout leaves most instances on the old image
    // for an unannounced time after deploy returns, so the smoke test would keep meeting the previous build.
    "--containers-rollout",
    "immediate",
    ...(dryRun ? ["--dry-run"] : []),
    ...(secretsFile ? ["--secrets-file", secretsFile] : []),
  ];
}
