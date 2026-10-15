import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Outputs } from "../builds.js";
import { leakedBuildSecret, withPublicValues } from "../secrets.js";
import type { DeployContext } from "./types.js";
import { buildIdPath } from "./wrangler.js";

export async function recordedOrBuilt(
  context: DeployContext,
  build: () => Promise<string | number>,
): Promise<{ dir: string; outputs?: Outputs } | number> {
  if (context.recorded) {
    const dir = await restoreAssets(context, context.recorded);
    return typeof dir === "number" ? dir : withPublic(context, { dir });
  }
  const dir = await build();
  if (typeof dir !== "number") {
    const leaked = await leakedBuildSecret(dir, context.buildSecrets);
    if (leaked) {
      context.io.stderr(
        `${leaked.file} holds the value of the build secret ${leaked.name}; nothing was shipped\n`,
      );
      return 1;
    }
  }
  if (typeof dir === "number" || !context.store)
    return typeof dir === "number" ? dir : withPublic(context, { dir });
  const archived = await archiveAssets(context, dir, context.store);
  return typeof archived === "number"
    ? archived
    : withPublic(context, { dir, outputs: { assets: archived } });
}

async function withPublic(
  context: DeployContext,
  built: { dir: string; outputs?: Outputs },
): Promise<{ dir: string; outputs?: Outputs } | number> {
  const { service } = context;
  const names = service.kind === "frontend" ? (service.public ?? []) : [];
  if (names.length === 0 || context.dryRun) return built;
  const dir = await withPublicValues(
    built.dir,
    join(context.workDir, `${context.name}-public`),
    context.publicValues,
    context.io,
  );
  if (typeof dir === "number") return dir;
  return {
    dir,
    ...(built.outputs
      ? { outputs: { ...built.outputs, public: names.join(",") } }
      : {}),
  };
}

export function runBuildCommand(
  context: DeployContext,
  command: string,
  cwd: string,
): Promise<number> {
  return context.io.run("sh", ["-c", command], {
    cwd,
    env: { ...context.buildEnv, BUILD_ID: context.buildId },
  });
}

export async function stampBuildId(
  dir: string,
  buildId: string,
): Promise<void> {
  await mkdir(join(dir, dirname(buildIdPath)), { recursive: true });
  await writeFile(join(dir, buildIdPath), buildId);
}

export async function staticBuild(
  context: DeployContext,
): Promise<string | number> {
  const { service, configDir } = context;
  if (service.kind !== "frontend" || !service.build.output) {
    throw new Error(`${context.name} has no build output`);
  }
  const code = await runBuildCommand(context, service.build.command, configDir);
  if (code !== 0) return code;
  const output = resolve(configDir, service.build.output);
  await stampBuildId(output, context.buildId);
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
