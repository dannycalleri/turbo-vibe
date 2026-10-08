import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkBuildId } from "../smoke.js";
import type { Adapter, DeployContext, ServiceContext } from "./types.js";
import {
  buildIdPath,
  wranglerDeployArgs,
  wranglerPushArgs,
  writeWorker,
} from "./wrangler.js";

type Backend = Extract<DeployContext["service"], { kind: "backend" }>;
type FrontendBuild = Extract<
  DeployContext["service"],
  { kind: "frontend" }
>["build"];

async function buildAndPush(
  context: DeployContext,
  backend: Backend,
): Promise<string | number> {
  const { io, configDir } = context;
  const dockerfile = resolve(configDir, backend.build.dockerfile);
  const tag = `${context.config.project}-${context.name}:${context.buildId}`;
  const options = { cwd: configDir, env: io.env };
  const built = await io.run(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "--build-arg",
      `BUILD_ID=${context.buildId}`,
      "--file",
      dockerfile,
      "--tag",
      tag,
      backend.build.context
        ? resolve(configDir, backend.build.context)
        : dirname(dockerfile),
    ],
    options,
  );
  if (built !== 0) return built;
  const pushed = await io.run(process.execPath, wranglerPushArgs(tag), options);
  if (pushed !== 0) return pushed;
  const inspected = await io.capture(
    "docker",
    ["image", "inspect", "--format", "{{json .RepoDigests}}", tag],
    options,
  );
  const repository = `registry.cloudflare.com/${io.env.CLOUDFLARE_ACCOUNT_ID}/${tag.split(":")[0]}@`;
  const digest = (JSON.parse(inspected.stdout || "[]") as string[]).find(
    (ref) => ref.startsWith(repository),
  );
  if (inspected.code !== 0 || !digest) {
    io.stderr(
      `cannot find the pushed digest of ${tag} in the Cloudflare registry\n`,
    );
    return 1;
  }
  return digest;
}

async function buildAssets(
  context: DeployContext,
  build: FrontendBuild,
): Promise<string | number> {
  const built = await context.io.run("sh", ["-c", build.command], {
    cwd: context.configDir,
    env: { ...context.buildEnv, BUILD_ID: context.buildId },
  });
  if (built !== 0) return built;
  const output = resolve(context.configDir, build.output);
  await mkdir(join(output, dirname(buildIdPath)), { recursive: true });
  await writeFile(join(output, buildIdPath), context.buildId);
  return output;
}

async function archiveAssets(
  context: DeployContext,
  dir: string,
  store: NonNullable<DeployContext["store"]>,
): Promise<string | number> {
  const archive = join(context.workDir, `${context.name}-assets.tar.gz`);
  await mkdir(context.workDir, { recursive: true });
  const code = await context.io.run("tar", ["-czf", archive, "-C", dir, "."], {
    cwd: context.workDir,
    env: context.io.env,
  });
  if (code !== 0) return code;
  const key = store.artifactKey(context.buildId, context.name);
  await store.put(key, new Uint8Array(await readFile(archive)));
  return key;
}

async function restoreAssets(
  context: DeployContext,
  recorded: NonNullable<DeployContext["recorded"]>,
): Promise<string | number> {
  const archive =
    recorded.assets && (await context.store?.get(recorded.assets));
  if (!archive) {
    context.io.stderr(
      `build ${context.buildId} has no recorded assets for ${context.name}\n`,
    );
    return 1;
  }
  const dir = join(context.workDir, `${context.name}-assets`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = `${dir}.tar.gz`;
  await writeFile(file, archive);
  return context.io
    .run("tar", ["-xzf", file, "-C", dir], {
      cwd: context.workDir,
      env: context.io.env,
    })
    .then((code) => (code === 0 ? dir : code));
}

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

function servedFrontend({ config, name }: ServiceContext): string | undefined {
  return Object.entries(config.services).find(
    ([, service]) => service.kind === "frontend" && service.serve_with === name,
  )?.[0];
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
    if (context.recorded && !context.recorded.image) {
      context.io.stderr(
        `build ${context.buildId} has no recorded image for ${context.name}\n`,
      );
      return { code: 1 };
    }
    let image = context.recorded?.image;
    if (!image && !context.dryRun) {
      const pushed = await buildAndPush(context, context.service);
      if (typeof pushed === "number") return { code: pushed };
      image = pushed;
    }
    const frontend = servedFrontend(context);
    const name = workerName(context);
    const assets = frontend ? context.assetsDirs[frontend] : undefined;
    const file = await writeWorker(join(context.workDir, name), {
      name,
      buildId: context.buildId,
      configDir: context.configDir,
      backend: context.service,
      secretNames: context.secretNames,
      ...(image ? { image } : {}),
      ...(assets ? { assets } : {}),
    });
    const code = await wranglerDeploy(context, file, context.secrets);
    return { code, ...(image ? { outputs: { image } } : {}) };
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
    const { service } = context;
    if (service.kind !== "frontend")
      throw new Error(`${context.name} is not a frontend`);
    const assets = context.recorded
      ? await restoreAssets(context, context.recorded)
      : await buildAssets(context, service.build);
    if (typeof assets === "number") return { code: assets };

    let outputs: Record<string, string> | undefined;
    if (context.store && !context.recorded) {
      const archived = await archiveAssets(context, assets, context.store);
      if (typeof archived === "number") return { code: archived };
      outputs = { assets: archived };
    }
    if (service.serve_with) {
      return { code: 0, assetsDir: assets, ...(outputs ? { outputs } : {}) };
    }

    const name = workerName(context);
    const file = await writeWorker(join(context.workDir, name), {
      name,
      buildId: context.buildId,
      configDir: context.configDir,
      assets,
    });
    const code = await wranglerDeploy(context, file);
    return { code, assetsDir: assets, ...(outputs ? { outputs } : {}) };
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
