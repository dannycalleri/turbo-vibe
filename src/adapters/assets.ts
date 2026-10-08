import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Outputs } from "../builds.js";
import type { DeployContext } from "./types.js";
import { buildIdPath } from "./wrangler.js";

type FrontendBuild = Extract<
  DeployContext["service"],
  { kind: "frontend" }
>["build"];

export async function frontendAssets(
  context: DeployContext,
  build: FrontendBuild,
): Promise<{ dir: string; outputs?: Outputs } | number> {
  if (context.recorded) {
    const dir = await restoreAssets(context, context.recorded);
    return typeof dir === "number" ? dir : { dir };
  }
  const dir = await buildAssets(context, build);
  if (typeof dir === "number" || !context.store)
    return typeof dir === "number" ? dir : { dir };
  const archived = await archiveAssets(context, dir, context.store);
  return typeof archived === "number"
    ? archived
    : { dir, outputs: { assets: archived } };
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
