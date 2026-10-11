import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { checkBuildId } from "../smoke.js";
import {
  recordedOrBuilt,
  runBuildCommand,
  stampBuildId,
  staticBuild,
} from "./assets.js";
import type {
  Adapter,
  DeployContext,
  DeployResult,
  ServiceContext,
} from "./types.js";
import { buildIdPath, runtimeConfigPath } from "./wrangler.js";

const require = createRequire(import.meta.url);
const vercelBin = join(
  dirname(require.resolve("vercel/package.json")),
  "dist",
  "vc.js",
);
const cnameTarget = "cname.vercel-dns.com";

function apiUrl({ hostname, backendHostname }: ServiceContext): string {
  return backendHostname === hostname ? "" : `https://${backendHostname}`;
}

export function vercelProject({
  config,
  name,
  environment,
}: ServiceContext): string {
  return `${config.project}-${name}-${environment}`;
}

function plan(context: ServiceContext) {
  return {
    vercel: {
      projects: {
        [vercelProject(context)]: {
          domain: context.hostname,
          environment: apiUrl(context)
            ? { TURBO_VIBE_API_URL: apiUrl(context) }
            : {},
        },
      },
    },
    cloudflare: {
      workers: {},
      hostnames: [],
      cnames: { [context.hostname]: cnameTarget },
    },
  };
}

async function shipPrebuilt(
  context: DeployContext,
  prepare: (output: string) => Promise<void>,
): Promise<number> {
  const root = join(context.workDir, `${context.name}-vercel`);
  const output = join(root, ".vercel", "output");
  await rm(root, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await prepare(output);
  if (context.dryRun) return 0;

  const projectId = (
    context.outputs.vercel_project_ids as Record<string, string> | undefined
  )?.[vercelProject(context)];
  if (!projectId) {
    context.io.stderr(
      `no Vercel project for ${context.name} in ${context.environment}; run apply first\n`,
    );
    return 1;
  }
  return context.io.run(
    process.execPath,
    [vercelBin, "deploy", "--prebuilt", "--prod", "--yes"],
    {
      cwd: root,
      env: {
        ...context.io.env,
        VERCEL_TOKEN: context.io.env.VERCEL_API_TOKEN,
        VERCEL_ORG_ID: context.io.env.VERCEL_TEAM_ID,
        VERCEL_PROJECT_ID: projectId,
      },
    },
  );
}

function smoke(context: Parameters<NonNullable<Adapter["smoke"]>>[0]) {
  return checkBuildId(
    {
      url: `https://${context.hostname}${buildIdPath}`,
      read: async (response) => (await response.text()).trim(),
    },
    context.buildId,
    context.io,
  );
}

const secrets = [
  "VERCEL_API_TOKEN",
  "VERCEL_TEAM_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
];

export const vercelStatic: Adapter = {
  target: "vercel-static",
  kind: "frontend",
  hostsStaticAssets: false,
  readsOutputs: true,
  crossOrigin: true,
  stability: "beta",
  secrets,
  outputs: ["assets"],
  plan,
  async deploy(context): Promise<DeployResult> {
    const assets = await recordedOrBuilt(context, () => staticBuild(context));
    if (typeof assets === "number") return { code: assets };
    const code = await shipPrebuilt(context, async (output) => {
      const files = join(output, "static");
      await cp(assets.dir, files, { recursive: true, verbatimSymlinks: true });
      await writeFile(
        join(output, "config.json"),
        JSON.stringify({ version: 3 }),
      );
      await mkdir(dirname(join(files, runtimeConfigPath)), { recursive: true });
      await writeFile(
        join(files, runtimeConfigPath),
        JSON.stringify({ apiUrl: apiUrl(context) }),
      );
    });
    return {
      code,
      assetsDir: assets.dir,
      ...(assets.outputs ? { outputs: assets.outputs } : {}),
    };
  },
  smoke,
};

async function nextBuild(context: DeployContext): Promise<string | number> {
  const { service, configDir, io } = context;
  if (service.kind !== "frontend")
    throw new Error(`${context.name} is not a frontend`);
  const root = resolve(configDir, service.build.root ?? ".");
  const installed = await runBuildCommand(context, service.build.command, root);
  if (installed !== 0) return installed;
  const link = join(root, ".vercel", "project.json");
  const existing = await readFile(link, "utf8").catch(() => undefined);
  await mkdir(dirname(link), { recursive: true });
  await writeFile(
    link,
    JSON.stringify({
      projectId: "turbo-vibe",
      orgId: "turbo-vibe",
      settings: { framework: "nextjs" },
    }),
  );
  let built: number;
  try {
    built = await io.run(
      process.execPath,
      // Without --standalone the functions name files in this project's node_modules, which the archived output lacks.
      [vercelBin, "build", "--prod", "--yes", "--standalone"],
      {
        cwd: root,
        env: {
          ...context.buildEnv,
          BUILD_ID: context.buildId,
          VERCEL_TELEMETRY_DISABLED: "1",
        },
      },
    );
  } finally {
    if (existing === undefined) await rm(link, { force: true });
    else await writeFile(link, existing);
  }
  if (built !== 0) return built;
  const output = join(root, ".vercel", "output");
  await stampBuildId(join(output, "static"), context.buildId);
  return output;
}

export const vercelNextjs: Adapter = {
  target: "vercel-nextjs",
  kind: "frontend",
  hostsStaticAssets: false,
  buildsOwnOutput: true,
  readsOutputs: true,
  crossOrigin: true,
  stability: "beta",
  secrets,
  outputs: ["assets"],
  plan,
  async deploy(context): Promise<DeployResult> {
    const built = await recordedOrBuilt(context, () => nextBuild(context));
    if (typeof built === "number") return { code: built };
    const code = await shipPrebuilt(context, (output) =>
      cp(built.dir, output, { recursive: true, verbatimSymlinks: true }),
    );
    return { code, ...(built.outputs ? { outputs: built.outputs } : {}) };
  },
  smoke,
};
