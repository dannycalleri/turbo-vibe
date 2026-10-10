import { join } from "node:path";
import { adapterFor, adapters } from "./adapters/index.js";
import type { ServiceContext } from "./adapters/types.js";
import { missingVariables, readOutputs } from "./apply.js";
import { BuildStore, choosePromotion, type Outputs } from "./builds.js";
import type { Config, EnvironmentName } from "./config/schema.js";
import {
  type Connection,
  runtimeUrl,
  transactionPoolerProblem,
} from "./database.js";
import { stateSecrets } from "./infrastructure.js";
import type { Io } from "./io.js";
import { callbackUrl, hostOf, layout, originSettings } from "./origins.js";

export interface Project {
  config: Config;
  configDir: string;
}

function contexts(
  config: Config,
  environment: EnvironmentName,
): ServiceContext[] {
  const hosts = layout(config, environment);
  return Object.entries(config.services).map(([name, service]) => ({
    config,
    name,
    service,
    environment,
    hostname: hostOf(hosts, service),
    backendHostname: hosts.backendHostname,
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

const originSecrets = [
  "ALLOWED_ORIGINS",
  "FRONTEND_URL",
  "COOKIE_DOMAIN",
] as const;

export function runtimeSecretNames(config: Config): string[] {
  return [
    ...(database(config) ? ["DATABASE_URL"] : []),
    ...(hasIdentity(config) ? [...identitySecrets, "WORKOS_REDIRECT_URI"] : []),
    ...(layout(config, "staging").crossOrigin ? originSecrets : []),
  ];
}

function needsOutputs(config: Config): boolean {
  return Object.values(config.services).some(
    (service) =>
      service.kind === "database" ||
      adapterFor(service.target).readsOutputs === true,
  );
}

async function environmentOutputs(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<Record<string, unknown> | undefined> {
  if (!needsOutputs(config)) return {};
  const outputs = await readOutputs(config, environment, io);
  if (!outputs)
    io.stderr(
      `cannot read the ${environment} infrastructure outputs; run apply first\n`,
    );
  return outputs;
}

function runtimeSecrets(
  config: Config,
  environment: EnvironmentName,
  outputs: Readonly<Record<string, unknown>>,
  io: Io,
): Record<string, string> | undefined {
  const secrets: Record<string, string> = {};
  const redirectUri = callbackUrl(config, environment);
  if (redirectUri) {
    for (const name of identitySecrets) secrets[name] = io.env[name] ?? "";
    secrets.WORKOS_REDIRECT_URI = redirectUri;
  }
  const origins = originSettings(config, environment);
  if (origins) {
    secrets.ALLOWED_ORIGINS = origins.allowedOrigins.join(",");
    secrets.FRONTEND_URL = origins.frontendUrl;
    secrets.COOKIE_DOMAIN = origins.cookieDomain ?? "";
  }
  const name = database(config);
  if (!name) return secrets;
  const connection = outputs[`supabase_${name}_connection`] as
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

function deploySecrets(config: Config): string[] {
  const names = new Set<string>([
    ...stateSecrets,
    ...(hasIdentity(config) ? identitySecrets : []),
  ]);
  for (const service of Object.values(config.services)) {
    const adapter = adapterFor(service.target);
    if (!adapter.deploy) continue;
    for (const name of adapter.secrets) names.add(name);
  }
  return [...names];
}

interface DeployRun {
  outputs: Readonly<Record<string, unknown>>;
  buildId: string;
  dryRun: boolean;
  secrets: Readonly<Record<string, string>>;
  store?: BuildStore;
  recorded?: Readonly<Record<string, Outputs>>;
}

async function deployServices(
  { config, configDir }: Project,
  environment: EnvironmentName,
  run: DeployRun,
  io: Io,
): Promise<Record<string, Outputs> | number> {
  const workDir = join(io.cwd, ".turbo-vibe", "wrangler", environment);
  // Frontends build first: a backend's Worker uploads the assets of the frontend served with it.
  const ordered = contexts(config, environment).sort(
    (a, b) =>
      Number(a.service.kind !== "frontend") -
      Number(b.service.kind !== "frontend"),
  );
  const outputs: Record<string, Outputs> = {};
  const assetsDirs: Record<string, string> = {};
  for (const context of ordered) {
    const adapter = adapterFor(context.service.target);
    if (!adapter.deploy) continue;
    const recorded = run.recorded?.[context.name];
    if (run.recorded && !recorded) {
      io.stderr(
        `build ${run.buildId} has no recorded outputs for ${context.name}; nothing is rebuilt during promotion\n`,
      );
      return 1;
    }
    io.stdout(
      `deploy ${context.name} (${context.service.target}) to ${environment}\n`,
    );
    const result = await adapter.deploy({
      ...context,
      buildId: run.buildId,
      secretNames: runtimeSecretNames(config),
      secrets: run.secrets,
      buildEnv: withoutCredentials(io.env),
      outputs: run.outputs,
      dryRun: run.dryRun,
      configDir,
      workDir,
      io,
      assetsDirs,
      ...(recorded ? { recorded } : {}),
      ...(run.store ? { store: run.store } : {}),
    });
    if (result.code !== 0) {
      io.stderr(
        `deploy ${context.name} failed with exit code ${result.code}\n`,
      );
      return result.code;
    }
    if (result.outputs) outputs[context.name] = result.outputs;
    if (result.assetsDir) assetsDirs[context.name] = result.assetsDir;
  }
  return outputs;
}

export async function deploy(
  project: Project,
  environment: EnvironmentName,
  { buildId, dryRun }: { buildId: string; dryRun: boolean },
  io: Io,
): Promise<number> {
  const { config } = project;
  if (environment === "production" && !dryRun) {
    io.stderr(
      "production is deployed with `turbo-vibe promote`, from a staging build that passed its smoke test\n",
    );
    return 1;
  }
  if (!dryRun && missingVariables(deploySecrets(config), io)) return 1;
  const infra = dryRun ? {} : await environmentOutputs(config, environment, io);
  if (!infra) return 1;
  const secrets = dryRun ? {} : runtimeSecrets(config, environment, infra, io);
  if (!secrets) return 1;
  const store = dryRun ? undefined : new BuildStore(io, config.project);
  const outputs = await deployServices(
    project,
    environment,
    { buildId, dryRun, secrets, outputs: infra, ...(store ? { store } : {}) },
    io,
  );
  if (typeof outputs === "number") return outputs;
  await store?.putRecord({
    buildId,
    createdAt: new Date().toISOString(),
    smoke: "pending",
    services: outputs,
  });
  return 0;
}

export async function promote(
  project: Project,
  environment: EnvironmentName,
  { buildId, choose }: { buildId?: string; choose?: boolean },
  io: Io,
): Promise<number> {
  const { config } = project;
  if (environment !== "production") {
    io.stderr(
      "promote deploys to production; staging is deployed on every merge\n",
    );
    return 1;
  }
  if (missingVariables(deploySecrets(config), io)) return 1;
  const store = new BuildStore(io, config.project);
  const chosen = buildId
    ? await store.getRecord(buildId)
    : choosePromotion(await store.listRecords());
  if (!chosen) {
    io.stderr(
      buildId
        ? `build ${buildId} has no record; production is unchanged\n`
        : "no staging build has passed its smoke test; production is unchanged\n",
    );
    return 1;
  }
  if (chosen.smoke !== "passed") {
    io.stderr(
      `build ${chosen.buildId} has not passed its smoke test (${chosen.smoke}); production is unchanged\n`,
    );
    return 1;
  }
  if (choose) {
    io.stdout(`${chosen.buildId}\n`);
    return 0;
  }
  io.stdout(`promote build ${chosen.buildId} to production\n`);
  const infra = await environmentOutputs(config, environment, io);
  if (!infra) return 1;
  const secrets = runtimeSecrets(config, environment, infra, io);
  if (!secrets) return 1;
  const outputs = await deployServices(
    project,
    environment,
    {
      buildId: chosen.buildId,
      dryRun: false,
      secrets,
      outputs: infra,
      store,
      recorded: chosen.services,
    },
    io,
  );
  return typeof outputs === "number" ? outputs : 0;
}

export async function smoke(
  config: Config,
  environment: EnvironmentName,
  buildId: string,
  io: Io,
): Promise<number> {
  const records = environment === "staging";
  if (records && missingVariables(stateSecrets, io)) return 1;
  let failed = false;
  for (const context of contexts(config, environment)) {
    const adapter = adapterFor(context.service.target);
    if (!adapter.smoke) continue;
    const result = await adapter.smoke({ ...context, buildId, io });
    (result.ok ? io.stdout : io.stderr)(
      `${result.ok ? "ok" : "FAIL"} ${context.name}: ${result.message}\n`,
    );
    failed ||= !result.ok;
  }
  if (records) {
    const store = new BuildStore(io, config.project);
    const record = await store.getRecord(buildId);
    if (!record) {
      io.stderr(`no build record for ${buildId}; it cannot be promoted\n`);
      return 1;
    }
    await store.putRecord({ ...record, smoke: failed ? "failed" : "passed" });
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
