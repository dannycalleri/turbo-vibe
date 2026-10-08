import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/schema.js";

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

export function workerEntry(
  backend: Backend,
  secretNames: readonly string[] = [],
): string {
  const sleepAfter = backend.container?.sleep_after ?? "5m";
  const forwarded = secretNames
    .map((name) => `, ${name}: env.${name}`)
    .join("");
  return `import { Container, getContainer } from ${JSON.stringify(containersModule)};

export class Backend extends Container {
  defaultPort = 8080;
  sleepAfter = ${JSON.stringify(sleepAfter)};

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = { PORT: "8080"${forwarded} };
  }
}

export default {
  fetch(request, env) {
    return getContainer(env.BACKEND, "default").fetch(request);
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
          image_vars: { BUILD_ID: spec.buildId },
        };
    Object.assign(config, {
      main: "worker.js",
      containers: [
        {
          ...container,
          instance_type: spec.backend.container?.instance_type ?? "lite",
          max_instances: 1,
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
      ...(spec.backend ? { run_worker_first: ["/api/*"] } : {}),
    };
  }
  return config;
}

export async function writeWorker(
  dir: string,
  spec: WorkerSpec,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  if (spec.backend)
    await writeFile(
      join(dir, "worker.js"),
      workerEntry(spec.backend, spec.secretNames),
    );
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
    ...(dryRun ? ["--dry-run"] : []),
    ...(secretsFile ? ["--secrets-file", secretsFile] : []),
  ];
}
