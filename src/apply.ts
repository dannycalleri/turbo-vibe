import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Change,
  diagnostics,
  formatChanges,
  owners,
  summarize,
  type TofuPlan,
} from "./changes.js";
import {
  type Config,
  type EnvironmentName,
  isPreview,
} from "./config/schema.js";
import { discoverRedirectUris } from "./identity.js";
import {
  branchedDatabases,
  requiredSecrets,
  rootModule,
} from "./infrastructure.js";
import type { Io } from "./io.js";
import { appSecretValues } from "./secrets.js";

export function missingVariables(names: Iterable<string>, io: Io): boolean {
  const missing = [...names].filter((name) => !io.env[name]).sort();
  if (missing.length === 0) return false;
  io.stderr(`missing environment variables: ${missing.join(", ")}\n`);
  return true;
}

async function writeRoot(
  config: Config,
  environment: EnvironmentName,
  io: Io,
  managedRedirectUris: Readonly<Record<string, string[]>> = {},
  parentRefs: Readonly<Record<string, string>> = {},
): Promise<string> {
  const dir = join(io.cwd, ".turbo-vibe", "tofu", environment);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "main.tf.json"),
    `${JSON.stringify(rootModule(config, environment, io.env, managedRedirectUris, parentRefs), null, 2)}\n`,
  );
  return dir;
}

// A branch learns only its parent's project ref, so no environment needs another environment's state.
export async function parentProjectRefs(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<Record<string, string> | string> {
  const branched = branchedDatabases(config, environment, io.env);
  if (branched.length === 0) return {};
  const response = await io.fetch("https://api.supabase.com/v1/projects", {
    headers: { authorization: `Bearer ${io.env.SUPABASE_ACCESS_TOKEN}` },
  });
  if (!response.ok)
    return `cannot list the Supabase projects (HTTP ${response.status})`;
  const projects = (await response.json()) as {
    id: string;
    name: string;
    organization_id?: string;
    organization_slug?: string;
  }[];
  const refs: Record<string, string> = {};
  for (const { module, parent, parentName, organization } of branched) {
    const named = projects.filter(
      (project) =>
        project.name === parentName &&
        (!organization ||
          project.organization_id === organization ||
          project.organization_slug === organization),
    );
    if (named.length === 0)
      return `the Supabase project ${parentName} does not exist yet; apply ${parent} first`;
    if (named.length > 1)
      return `more than one Supabase project is named ${parentName} (${named.map((project) => project.id).join(", ")}); set the database's organization so that one matches`;
    refs[module] = named[0]?.id ?? "";
  }
  return refs;
}

async function initRoot(
  config: Config,
  environment: EnvironmentName,
  io: Io,
  parentRefs: Readonly<Record<string, string>> = {},
): Promise<{ dir: string; code: number }> {
  const dir = await writeRoot(config, environment, io, {}, parentRefs);
  // The backend is regenerated from the config on every run, so a backend cached in .terraform by another
  // project's config in the same directory (a monorepo, or the live tests) must not stop init.
  const code = await io.run("tofu", ["init", "-input=false", "-reconfigure"], {
    cwd: dir,
    env: io.env,
  });
  return { dir, code };
}

async function prepare(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<{ dir: string } | { code: number }> {
  if (missingVariables(requiredSecrets(config), io)) return { code: 1 };
  const parentRefs = await parentProjectRefs(config, environment, io);
  if (typeof parentRefs === "string") {
    io.stderr(`${parentRefs}\n`);
    return { code: 1 };
  }
  const { dir, code } = await initRoot(config, environment, io, parentRefs);
  if (code !== 0) return { code };
  if (
    Object.values(config.services).some(
      (service) => service.kind === "identity",
    )
  ) {
    const outputs = await currentOutputs(dir, io);
    if (!outputs) {
      io.stderr(`cannot read the current ${environment} outputs\n`);
      return { code: 1 };
    }
    let managed: Record<string, string[]>;
    try {
      managed = await discoverRedirectUris(config, environment, outputs, io);
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return { code: 1 };
    }
    await writeRoot(config, environment, io, managed, parentRefs);
  }
  return { dir };
}

async function planChanges(
  config: Config,
  environment: EnvironmentName,
  io: Io,
  dir: string,
  planFile: string,
): Promise<Change[] | number> {
  const planned = await io.capture(
    "tofu",
    ["plan", "-input=false", "-json", `-out=${planFile}`],
    { cwd: dir, env: io.env },
  );
  for (const message of diagnostics(planned.stdout)) {
    io.stderr(`${message}\n`);
  }
  if (planned.code !== 0) return planned.code;
  const shown = await io.capture("tofu", ["show", "-json", planFile], {
    cwd: dir,
    env: io.env,
  });
  if (shown.code !== 0) return shown.code;
  return summarize(
    JSON.parse(shown.stdout) as TofuPlan,
    owners(config, environment),
  );
}

export async function plan(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<number> {
  const prepared = await prepare(config, environment, io);
  if ("code" in prepared) return prepared.code;
  const planFile = join(prepared.dir, "tfplan");
  try {
    const changes = await planChanges(
      config,
      environment,
      io,
      prepared.dir,
      planFile,
    );
    if (typeof changes === "number") return changes;
    io.stdout(`${formatChanges(environment, changes)}\n`);
    return 0;
  } finally {
    await rm(planFile, { force: true });
  }
}

export async function apply(
  config: Config,
  environment: EnvironmentName,
  io: Io,
  { allowDeletions = false }: { allowDeletions?: boolean } = {},
): Promise<number> {
  // The deploy after apply needs these; stopping here keeps infrastructure and migrations from changing first.
  if (!appSecretValues(config, environment, io)) return 1;
  const prepared = await prepare(config, environment, io);
  if ("code" in prepared) return prepared.code;
  const planFile = join(prepared.dir, "tfplan");
  try {
    const changes = await planChanges(
      config,
      environment,
      io,
      prepared.dir,
      planFile,
    );
    if (typeof changes === "number") return changes;
    io.stdout(`${formatChanges(environment, changes)}\n`);
    const destructive = changes.filter(
      (change) => change.action === "delete" || change.action === "replace",
    );
    if (destructive.length > 0 && !isPreview(environment) && !allowDeletions) {
      io.stderr(
        `refusing to apply ${environment}: it would delete or replace ${destructive.length} resource(s):\n${destructive
          .map((change) => `  ${change.action} ${change.address}\n`)
          .join(
            "",
          )}if that is intended, run apply again with --allow-deletions (the workflows' allow-deletions input)\n`,
      );
      return 1;
    }
    return await io.run("tofu", ["apply", "-input=false", planFile], {
      cwd: prepared.dir,
      env: io.env,
    });
  } finally {
    await rm(planFile, { force: true });
  }
}

export async function destroy(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<number> {
  if (!isPreview(environment)) {
    io.stderr(
      `refusing to destroy ${environment}: only previews are ever removed\n`,
    );
    return 1;
  }
  if (missingVariables(requiredSecrets(config), io)) return 1;
  // A preview whose parent is already gone still has to be removable.
  const parentRefs = await parentProjectRefs(config, environment, io);
  const { dir, code } = await initRoot(
    config,
    environment,
    io,
    typeof parentRefs === "string" ? {} : parentRefs,
  );
  if (code !== 0) return code;
  return io.run("tofu", ["destroy", "-input=false", "-auto-approve"], {
    cwd: dir,
    env: io.env,
  });
}

export async function readOutputs(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<Record<string, unknown> | undefined> {
  const { dir, code } = await initRoot(config, environment, io);
  if (code !== 0) return undefined;
  return currentOutputs(dir, io);
}

async function currentOutputs(
  dir: string,
  io: Io,
): Promise<Record<string, unknown> | undefined> {
  const result = await io.capture("tofu", ["output", "-json"], {
    cwd: dir,
    env: io.env,
  });
  if (result.code !== 0) return undefined;
  const outputs = JSON.parse(result.stdout) as Record<
    string,
    { value: unknown }
  >;
  return Object.fromEntries(
    Object.entries(outputs).map(([name, output]) => [name, output.value]),
  );
}
