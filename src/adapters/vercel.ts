import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { checkBuildId } from "../smoke.js";
import { frontendAssets } from "./assets.js";
import type { Adapter, DeployContext, ServiceContext } from "./types.js";
import { buildIdPath } from "./wrangler.js";

const require = createRequire(import.meta.url);
const vercelBin = join(
  dirname(require.resolve("vercel/package.json")),
  "dist",
  "vc.js",
);
const cnameTarget = "cname.vercel-dns.com";

export function vercelProject({
  config,
  name,
  environment,
}: ServiceContext): string {
  return `${config.project}-${name}-${environment}`;
}

async function prebuiltOutput(
  context: DeployContext,
  assets: string,
): Promise<string> {
  const root = join(context.workDir, `${context.name}-vercel`);
  const output = join(root, ".vercel", "output");
  await rm(root, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(assets, join(output, "static"), { recursive: true });
  await writeFile(join(output, "config.json"), JSON.stringify({ version: 3 }));
  return root;
}

export const vercelStatic: Adapter = {
  target: "vercel-static",
  kind: "frontend",
  hostsStaticAssets: false,
  readsOutputs: true,
  secrets: [
    "VERCEL_API_TOKEN",
    "VERCEL_TEAM_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ZONE_ID",
  ],
  outputs: ["assets"],
  plan(context) {
    return {
      vercel: {
        projects: { [vercelProject(context)]: { domain: context.hostname } },
      },
      cloudflare: {
        workers: {},
        hostnames: [],
        cnames: { [context.hostname]: cnameTarget },
      },
    };
  },
  async deploy(context) {
    const { service, io } = context;
    if (service.kind !== "frontend")
      throw new Error(`${context.name} is not a frontend`);
    const assets = await frontendAssets(context, service.build);
    if (typeof assets === "number") return { code: assets };
    const result = {
      assetsDir: assets.dir,
      ...(assets.outputs ? { outputs: assets.outputs } : {}),
    };
    const root = await prebuiltOutput(context, assets.dir);
    if (context.dryRun) return { code: 0, ...result };

    const projectId = (
      context.outputs.vercel_project_ids as Record<string, string> | undefined
    )?.[vercelProject(context)];
    if (!projectId) {
      io.stderr(
        `no Vercel project for ${context.name} in ${context.environment}; run apply first\n`,
      );
      return { code: 1 };
    }
    const code = await io.run(
      process.execPath,
      [vercelBin, "deploy", "--prebuilt", "--prod", "--yes"],
      {
        cwd: root,
        env: {
          ...io.env,
          VERCEL_TOKEN: io.env.VERCEL_API_TOKEN,
          VERCEL_ORG_ID: io.env.VERCEL_TEAM_ID,
          VERCEL_PROJECT_ID: projectId,
        },
      },
    );
    return { code, ...result };
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
