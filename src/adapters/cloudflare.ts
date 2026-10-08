import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkBuildId } from "../smoke.js";
import type { Adapter, DeployContext, ServiceContext } from "./types.js";
import { buildIdPath, wranglerDeployArgs, writeWorker } from "./wrangler.js";

const secrets = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
] as const;

export function workerName({
  config,
  name,
  environment,
}: ServiceContext): string {
  return `${config.project}-${name}-${environment}`;
}

function servedFrontend({ config, name }: ServiceContext) {
  return Object.values(config.services).find(
    (service) => service.kind === "frontend" && service.serve_with === name,
  );
}

async function wranglerDeploy(
  context: DeployContext,
  file: string,
  secrets: Readonly<Record<string, string>> = {},
): Promise<number> {
  const secretsFile =
    !context.dryRun && Object.keys(secrets).length > 0
      ? join(dirname(file), "secrets.json")
      : undefined;
  if (secretsFile) {
    await writeFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  }
  try {
    return await context.io.run(
      process.execPath,
      wranglerDeployArgs(file, context.dryRun, secretsFile),
      { cwd: dirname(file), env: context.io.env },
    );
  } finally {
    if (secretsFile) await rm(secretsFile, { force: true });
  }
}

export const cloudflareContainer: Adapter = {
  target: "cloudflare-container",
  kind: "backend",
  hostsStaticAssets: true,
  secrets,
  outputs: ["url", "worker"],
  plan(context) {
    const route = servedFrontend(context)
      ? `${context.hostname}/*`
      : `${context.hostname}/api/*`;
    return {
      cloudflare: {
        workers: { [workerName(context)]: { routes: [route] } },
        hostnames: [context.hostname],
      },
    };
  },
  async deploy(context) {
    if (context.service.kind !== "backend")
      throw new Error(`${context.name} is not a backend`);
    const frontend = servedFrontend(context);
    const name = workerName(context);
    const file = await writeWorker(join(context.workDir, name), {
      name,
      buildId: context.buildId,
      configDir: context.configDir,
      backend: context.service,
      secretNames: context.secretNames,
      ...(frontend?.kind === "frontend"
        ? { assets: resolve(context.configDir, frontend.build.output) }
        : {}),
    });
    return wranglerDeploy(context, file, context.secrets);
  },
  smoke(context) {
    return checkBuildId(
      {
        url: `https://${context.hostname}/api/health`,
        read: async (response) => {
          const body: unknown = await response.json().catch(() => undefined);
          const buildId = (body as { build_id?: unknown } | undefined)
            ?.build_id;
          return typeof buildId === "string" ? buildId : undefined;
        },
      },
      context.buildId,
      context.io,
    );
  },
};

export const cloudflareStatic: Adapter = {
  target: "cloudflare-static",
  kind: "frontend",
  hostsStaticAssets: true,
  secrets,
  outputs: ["url", "worker"],
  plan(context) {
    if (context.service.kind === "frontend" && context.service.serve_with) {
      return {};
    }
    return {
      cloudflare: {
        workers: {
          [workerName(context)]: { routes: [`${context.hostname}/*`] },
        },
        hostnames: [context.hostname],
      },
    };
  },
  async deploy(context) {
    const { service, io, configDir } = context;
    if (service.kind !== "frontend")
      throw new Error(`${context.name} is not a frontend`);
    const built = await io.run("sh", ["-c", service.build.command], {
      cwd: configDir,
      env: { ...io.env, BUILD_ID: context.buildId },
    });
    if (built !== 0) return built;

    const output = resolve(configDir, service.build.output);
    await mkdir(join(output, dirname(buildIdPath)), { recursive: true });
    await writeFile(join(output, buildIdPath), context.buildId);
    if (service.serve_with) return 0;

    const name = workerName(context);
    const file = await writeWorker(join(context.workDir, name), {
      name,
      buildId: context.buildId,
      configDir,
      assets: output,
    });
    return wranglerDeploy(context, file);
  },
  smoke(context) {
    return checkBuildId(
      {
        url: `https://${context.hostname}${buildIdPath}`,
        read: async (response) => (await response.text()).trim(),
      },
      context.buildId,
      context.io,
    );
  },
};
