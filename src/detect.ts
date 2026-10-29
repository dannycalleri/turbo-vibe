import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Answers } from "./init.js";

export type Lockfile = "npm" | "pnpm" | "yarn" | "bun";

const lockfiles: [string, Lockfile][] = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

export interface Repository {
  folder: string;
  lockfile?: Lockfile;
  packageJson?: string;
  goMod?: string;
  dockerfile: boolean;
  supabase: boolean;
}

export type Defaults = Partial<Omit<Answers, "assistant">>;

export function projectName(raw: string): string | undefined {
  const normalized = (raw.split("/").pop() ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 41)
    .replace(/-+$/, "");
  return normalized || undefined;
}

export function detectProject(repository: Repository): Defaults {
  let manifest: {
    name?: unknown;
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  } = {};
  try {
    const parsed = JSON.parse(repository.packageJson ?? "{}");
    if (parsed && typeof parsed === "object") manifest = parsed;
  } catch {}
  const name =
    projectName(typeof manifest.name === "string" ? manifest.name : "") ??
    projectName(repository.folder);
  const defaults: Defaults = name ? { name } : {};
  if (repository.packageJson === undefined && !repository.dockerfile) {
    return defaults;
  }
  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  });
  return {
    ...defaults,
    backend: repository.dockerfile ? "cloudflare-container" : "none",
    frontend: dependencies.includes("next")
      ? "vercel-nextjs"
      : typeof manifest.scripts?.build === "string"
        ? "cloudflare-static"
        : "none",
    database: repository.supabase ? "supabase" : "none",
    identity:
      dependencies.some((dependency) =>
        dependency.startsWith("@workos-inc/"),
      ) || (repository.goMod ?? "").includes("github.com/workos/")
        ? "workos"
        : "none",
  };
}

export async function readRepository(cwd: string): Promise<Repository> {
  const text = (name: string) =>
    readFile(join(cwd, name), "utf8").catch(() => undefined);
  const exists = (name: string) =>
    stat(join(cwd, name)).then(
      () => true,
      () => false,
    );
  const [packageJson, goMod, dockerfile, supabase, ...locks] =
    await Promise.all([
      text("package.json"),
      text("go.mod"),
      exists("Dockerfile"),
      exists("supabase"),
      ...lockfiles.map(([name]) => exists(name)),
    ]);
  const lockfile = lockfiles.find((_, index) => locks[index])?.[1];
  return {
    folder: basename(cwd),
    ...(lockfile ? { lockfile } : {}),
    ...(packageJson === undefined ? {} : { packageJson }),
    ...(goMod === undefined ? {} : { goMod }),
    dockerfile,
    supabase,
  };
}
