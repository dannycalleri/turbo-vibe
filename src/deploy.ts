import { join } from "node:path";
import { adapterFor, adapters } from "./adapters/index.js";
import type { ServiceContext } from "./adapters/types.js";
import { callbackUrl } from "./adapters/workos.js";
import { readOutputs } from "./apply.js";
import type { Config, EnvironmentName } from "./config/schema.js";
import {
  type Connection,
  runtimeUrl,
  transactionPoolerProblem,
} from "./database.js";
import { stateSecrets } from "./infrastructure.js";
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

function database(config: Config): string | undefined {
  return Object.entries(config.services).find(
    ([, service]) => service.kind === "database",
  )?.[0];
}

function hasIdentity(config: Config): boolean {
  return Object.values(config.services).some(
    (service) => service.kind === "identity",
  );
}

const identitySecrets = ["WORKOS_CLIENT_ID", "WORKOS_API_KEY"] as const;

export function runtimeSecretNames(config: Config): string[] {
  return [
    ...(database(config) ? ["DATABASE_URL"] : []),
    ...(hasIdentity(config) ? [...identitySecrets, "WORKOS_REDIRECT_URI"] : []),
  ];
}

async function runtimeSecrets(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<Record<string, string> | undefined> {
  const secrets: Record<string, string> = {};
  const redirectUri = callbackUrl(config, environment);
  if (redirectUri) {
    for (const name of identitySecrets) secrets[name] = io.env[name] ?? "";
    secrets.WORKOS_REDIRECT_URI = redirectUri;
  }
  const name = database(config);
  if (!name) return secrets;
  const outputs = await readOutputs(config, environment, io);
  const connection = outputs?.[`supabase_${name}_connection`] as
    | Connection
    | undefined;
  const url = connection && runtimeUrl(connection);
  if (!url) {
    io.stderr(
      `no runtime connection for database ${name} in ${environment}; run apply first\n`,
    );
    return undefined;
  }
  const problem = transactionPoolerProblem(url);
  if (problem) {
    io.stderr(`${problem}\n`);
    return undefined;
  }
  secrets.DATABASE_URL = url;
  return secrets;
}

// A frontend build bakes whatever it reads into public files, so it never sees a credential.
function withoutCredentials(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const credentials = new Set<string>([
    ...stateSecrets,
    ...Object.values(adapters).flatMap((adapter) => adapter.secrets),
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !credentials.has(name)),
  );
}

function missingSecrets(config: Config, io: Io): string[] {
  const names = new Set<string>([
    ...(database(config) ? stateSecrets : []),
    ...(hasIdentity(config) ? identitySecrets : []),
  ]);
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
  const secrets = dryRun ? {} : await runtimeSecrets(config, environment, io);
  if (!secrets) return 1;
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
      secretNames: runtimeSecretNames(config),
      secrets,
      buildEnv: withoutCredentials(io.env),
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
