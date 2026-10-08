import { join } from "node:path";
import { adapterFor } from "./adapters/index.js";
import type { ServiceContext } from "./adapters/types.js";
import type { Config, EnvironmentName } from "./config/schema.js";
import type { Io } from "./io.js";
import { hostnameFor } from "./plan.js";

export interface Project {
  config: Config;
  configDir: string;
}

function contexts(
  config: Config,
  environment: EnvironmentName,
): ServiceContext[] {
  const hostname = hostnameFor(config, environment);
  return Object.entries(config.services).map(([name, service]) => ({
    config,
    name,
    service,
    environment,
    hostname,
  }));
}

function missingSecrets(config: Config, io: Io): string[] {
  const names = new Set<string>();
  for (const service of Object.values(config.services)) {
    const adapter = adapterFor(service.target);
    if (!adapter.deploy) continue;
    for (const name of adapter.secrets) names.add(name);
  }
  return [...names].filter((name) => !io.env[name]).sort();
}

export async function deploy(
  { config, configDir }: Project,
  environment: EnvironmentName,
  { buildId, dryRun }: { buildId: string; dryRun: boolean },
  io: Io,
): Promise<number> {
  const missing = dryRun ? [] : missingSecrets(config, io);
  if (missing.length > 0) {
    io.stderr(`missing environment variables: ${missing.join(", ")}\n`);
    return 1;
  }
  const workDir = join(io.cwd, ".turbo-vibe", "wrangler", environment);
  // Frontends build first: a backend's Worker uploads the assets of the frontend served with it.
  const ordered = contexts(config, environment).sort(
    (a, b) =>
      Number(a.service.kind !== "frontend") -
      Number(b.service.kind !== "frontend"),
  );
  for (const context of ordered) {
    const adapter = adapterFor(context.service.target);
    if (!adapter.deploy) continue;
    io.stdout(
      `deploy ${context.name} (${context.service.target}) to ${environment}\n`,
    );
    const code = await adapter.deploy({
      ...context,
      buildId,
      dryRun,
      configDir,
      workDir,
      io,
    });
    if (code !== 0) {
      io.stderr(`deploy ${context.name} failed with exit code ${code}\n`);
      return code;
    }
  }
  return 0;
}

export async function smoke(
  config: Config,
  environment: EnvironmentName,
  buildId: string,
  io: Io,
): Promise<number> {
  let failed = false;
  for (const context of contexts(config, environment)) {
    const adapter = adapterFor(context.service.target);
    if (!adapter.smoke) continue;
    const result = await adapter.smoke({
      ...context,
      buildId,
      io,
    });
    (result.ok ? io.stdout : io.stderr)(
      `${result.ok ? "ok" : "FAIL"} ${context.name}: ${result.message}\n`,
    );
    failed ||= !result.ok;
  }
  return failed ? 1 : 0;
}

export async function test(
  { config, configDir }: Project,
  io: Io,
): Promise<number> {
  for (const [name, service] of Object.entries(config.services)) {
    const command = "build" in service ? service.build.test : undefined;
    if (!command) continue;
    io.stdout(`test ${name}: ${command}\n`);
    const code = await io.run("sh", ["-c", command], {
      cwd: configDir,
      env: io.env,
    });
    if (code !== 0) {
      io.stderr(`test ${name} failed with exit code ${code}\n`);
      return code;
    }
  }
  return 0;
}
