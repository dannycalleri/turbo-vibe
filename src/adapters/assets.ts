import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Outputs } from "../builds.js";
import { fillPublicValues, leakedBuildSecret } from "../secrets.js";
import type { DeployContext } from "./types.js";
import { buildIdPath } from "./wrangler.js";

export interface SiteEdits {
  noindex?: boolean;
  analyticsToken?: string;
}

export async function recordedOrBuilt(
  context: DeployContext,
  build: () => Promise<string | number>,
  edits: SiteEdits = {},
): Promise<{ dir: string; outputs?: Outputs } | number> {
  const forEnvironment = (built: { dir: string; outputs?: Outputs }) =>
    forThisEnvironment(context, built, edits);
  if (context.recorded) {
    const dir = await restoreAssets(context, context.recorded);
    return typeof dir === "number" ? dir : forEnvironment({ dir });
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
    return typeof dir === "number" ? dir : forEnvironment({ dir });
  const archived = await archiveAssets(context, dir, context.store);
  return typeof archived === "number"
    ? archived
    : forEnvironment({ dir, outputs: { assets: archived } });
}

// The build tool may keep its output folder between builds, so changing it there could reach a later archive.
async function forThisEnvironment(
  context: DeployContext,
  built: { dir: string; outputs?: Outputs },
  edits: SiteEdits,
): Promise<{ dir: string; outputs?: Outputs } | number> {
  const { service } = context;
  const names = service.kind === "frontend" ? (service.public ?? []) : [];
  const fillPublic = names.length > 0 && !context.dryRun;
  if (!fillPublic && !edits.noindex && !edits.analyticsToken) return built;
  const copy = await copySite(
    built.dir,
    join(context.workDir, `${context.name}-site`),
  );
  const dir = fillPublic
    ? await fillPublicValues(copy, context.publicValues, context.io)
    : copy;
  if (typeof dir === "number") return dir;
  if (edits.noindex) await keepFromSearchEngines(dir);
  if (edits.analyticsToken) await addAnalytics(dir, edits.analyticsToken);
  return {
    dir,
    ...(built.outputs
      ? {
          outputs: fillPublic
            ? { ...built.outputs, public: names.join(",") }
            : built.outputs,
        }
      : {}),
  };
}

export async function copySite(dir: string, copy: string): Promise<string> {
  await rm(copy, { recursive: true, force: true });
  await mkdir(copy, { recursive: true });
  await cp(dir, copy, { recursive: true, verbatimSymlinks: true });
  return copy;
}

export async function hasNotFoundPage(dir: string): Promise<boolean> {
  const page = await stat(join(dir, "404.html")).catch(() => undefined);
  return page?.isFile() ?? false;
}

export async function keepFromSearchEngines(dir: string): Promise<void> {
  const file = join(dir, "_headers");
  const existing = await readFile(file, "utf8").catch(() => "");
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${separator}/*\n  X-Robots-Tag: noindex\n`);
}

const beaconScript = "https://static.cloudflareinsights.com/beacon.min.js";

export function analyticsBeacon(token: string): string {
  return `<script defer src="${beaconScript}" data-cf-beacon='${JSON.stringify({ token })}'></script>`;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export async function addAnalytics(dir: string, token: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.html?$/i.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    let page: string;
    try {
      page = utf8.decode(await readFile(file));
    } catch {
      continue;
    }
    if (page.includes(beaconScript)) continue;
    const end = [...page.matchAll(/<\/body\s*>/gi)].at(-1)?.index;
    if (end === undefined) continue;
    await writeFile(
      file,
      `${page.slice(0, end)}${analyticsBeacon(token)}${page.slice(end)}`,
    );
  }
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
