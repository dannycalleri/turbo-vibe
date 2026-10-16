import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/schema.js";
import { backendPort, backendPrefix, buildIdVariable } from "../contract.js";

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

export function workerEntry(
  backend: Backend,
  secretNames: readonly string[] = [],
): string {
  const sleepAfter = backend.container?.sleep_after ?? "5m";
  const forwarded = secretNames
    .map((name) => `, ${name}: env.${name}`)
    .join("");
  return `import { Container, getContainer } from ${JSON.stringify(containersModule)};
import { instanceName } from "./routing.js";

export class Backend extends Container {
  defaultPort = ${backendPort};
  sleepAfter = ${JSON.stringify(sleepAfter)};

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = { PORT: "${backendPort}"${forwarded} };
  }
}

export default {
  fetch(request, env) {
    return getContainer(env.BACKEND, instanceName(request)).fetch(request);
  },
};
`;
}

export interface WorkerSpec {
  name: string;
  image?: string;
  secretNames?: readonly string[];
  buildId: string;
  configDir: string;
  backend?: Backend;
  assets?: string;
}

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
          image_vars: { [buildIdVariable]: spec.buildId },
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
      not_found_handling: "single-page-application",
      ...(spec.backend ? { run_worker_first: [`${backendPrefix}*`] } : {}),
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
      workerEntry(spec.backend, spec.secretNames),
    );
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
