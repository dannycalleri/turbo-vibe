import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { adapterFor, adapters } from "./adapters/index.js";
import type { ServiceContext } from "./adapters/types.js";
import { missingVariables, readOutputs } from "./apply.js";
import {
  BuildStore,
  buildsBucket,
  choosePromotion,
  isBuildId,
  type Outputs,
} from "./builds.js";
import type { Config, EnvironmentName } from "./config/schema.js";
import { stateSecrets } from "./contract.js";
import {
  type Connection,
  runtimeUrl,
  transactionPoolerProblem,
} from "./database.js";
import { requiredSecrets } from "./infrastructure.js";
import type { Io } from "./io.js";
import {
  accessFor,
  analyticsFor,
  callbackUrl,
  hostOf,
  layout,
  originSettings,
} from "./origins.js";
import {
  appPublicValues,
  appSecrets,
  appSecretValues,
  buildSecrets,
  buildSecretValues,
  missingBuildSecrets,
  placeholder,
} from "./secrets.js";
import {
  commitOf,
  describePromotion,
  stagingBuilds,
} from "./staging-builds.js";

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

const originSecrets = ["ALLOWED_ORIGINS", "FRONTEND_URL"] as const;

export function runtimeSecretNames(config: Config): string[] {
  return [
    ...(database(config) ? ["DATABASE_URL"] : []),
    ...(hasIdentity(config) ? [...identitySecrets, "WORKOS_REDIRECT_URI"] : []),
    ...(layout(config, "staging").crossOrigin ? originSecrets : []),
  ];
}

const declaredSecrets = (service: Config["services"][string]) =>
  "secrets" in service ? (service.secrets ?? []) : [];

function needsOutputs(config: Config, environment: EnvironmentName): boolean {
  if (analyticsFor(config, environment)) return true;
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
  if (!needsOutputs(config, environment)) return {};
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
  config: Config,
): Record<string, string | undefined> {
  const credentials = new Set<string>([
    ...stateSecrets,
    ...Object.values(adapters).flatMap((adapter) => adapter.secrets),
    ...appSecrets(config).keys(),
    ...buildSecrets(config).keys(),
    "TURBO_VIBE_SECRETS",
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !credentials.has(name)),
  );
}

export function deploySecrets(config: Config): string[] {
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

export function environmentSecrets(
  config: Config,
  environment: EnvironmentName,
): string[] {
  return [
    ...new Set([
      ...requiredSecrets(config),
      ...deploySecrets(config),
      ...appSecrets(config).keys(),
      ...(environment === "production" ? ["TURBO_VIBE_BUILDS_BUCKET"] : []),
    ]),
  ].sort();
}

interface DeployRun {
  outputs: Readonly<Record<string, unknown>>;
  buildId: string;
  dryRun: boolean;
  secrets: Readonly<Record<string, string>>;
  store?: BuildStore;
  recorded?: Readonly<Record<string, Outputs>>;
  unchecked?: string[];
  appSecrets?: Readonly<Record<string, string>>;
  publicValues?: Readonly<Record<string, string>>;
  buildSecrets?: Readonly<Record<string, string>>;
}

function servicePublic(
  service: Config["services"][string],
  run: DeployRun,
  cleaned: Record<string, string | undefined>,
): {
  publicValues: Record<string, string>;
  buildEnv: Record<string, string | undefined>;
} {
  const names = service.kind === "frontend" ? (service.public ?? []) : [];
  return {
    publicValues: Object.fromEntries(
      names.flatMap((name) => {
        const value = run.publicValues?.[name];
        return value === undefined ? [] : [[name, value]];
      }),
    ),
    buildEnv: {
      ...cleaned,
      ...Object.fromEntries(names.map((name) => [name, placeholder(name)])),
    },
  };
}

function serviceSecrets(
  config: Config,
  service: Config["services"][string],
  run: DeployRun,
): { secretNames: string[]; secrets: Record<string, string> } {
  const own = declaredSecrets(service);
  const values = Object.fromEntries(
    own.flatMap((name) => {
      const value = run.appSecrets?.[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return service.kind === "backend"
    ? {
        secretNames: [...runtimeSecretNames(config), ...own],
        secrets: { ...run.secrets, ...values },
      }
    : { secretNames: own, secrets: values };
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
    const service = context.service;
    const ownBuild =
      service.kind === "backend" || service.kind === "frontend"
        ? (service.build.secrets ?? [])
        : [];
    const absent = ownBuild.filter((name) => !run.buildSecrets?.[name]);
    if (run.dryRun && absent.length > 0) {
      io.stdout(
        `${context.name}: not built, because the build secret ${absent.join(", ")} has no value here (a pull request from a fork receives none; locally, set it to build)\n`,
      );
      run.unchecked?.push(context.name);
      continue;
    }
    const buildSecretsOwn = Object.fromEntries(
      ownBuild.flatMap((name) => {
        const value = run.buildSecrets?.[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
    const result = await adapter.deploy({
      ...context,
      buildId: run.buildId,
      ...serviceSecrets(config, context.service, run),
      ...servicePublic(context.service, run, {
        ...withoutCredentials(io.env, config),
        ...buildSecretsOwn,
      }),
      buildSecrets: buildSecretsOwn,
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
    if (result.unchecked) run.unchecked?.push(context.name);
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
  const appSecrets = dryRun ? {} : appSecretValues(config, environment, io);
  const publicValues = dryRun ? {} : appPublicValues(config, environment, io);
  const build = buildSecretValues(config, io);
  const buildMissing = !dryRun && build.missing.length > 0;
  if (buildMissing) io.stderr(missingBuildSecrets(build.missing));
  if (!appSecrets || !publicValues || buildMissing) return 1;
  const infra = dryRun ? {} : await environmentOutputs(config, environment, io);
  if (!infra) return 1;
  if (!dryRun && analyticsTokenMissing(config, environment, infra, io))
    return 1;
  const secrets = dryRun ? {} : runtimeSecrets(config, environment, infra, io);
  if (!secrets) return 1;
  const store =
    dryRun || environment !== "staging"
      ? undefined
      : new BuildStore(io, config.project, buildsBucket(environment, io.env));
  const unchecked: string[] = [];
  const outputs = await deployServices(
    project,
    environment,
    {
      buildId,
      dryRun,
      secrets,
      outputs: infra,
      unchecked,
      appSecrets,
      publicValues,
      buildSecrets: build.values,
      ...(store ? { store } : {}),
    },
    io,
  );
  if (typeof outputs === "number") return outputs;
  if (dryRun) {
    const checked =
      unchecked.length === 0
        ? "every service built and checked"
        : `${unchecked.join(", ")} could not be fully built and checked (see above)`;
    io.stdout(
      `dry run passed: ${checked}; nothing was uploaded${database(config) ? ", and the database is not checked in a dry run" : ""}\n`,
    );
  }
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
  {
    buildId,
    choose,
    confirm: typed,
    newest,
    describe,
  }: {
    buildId?: string;
    choose?: boolean;
    confirm?: string;
    newest?: boolean;
    describe?: boolean;
  },
  io: Io,
): Promise<number> {
  const { config } = project;
  if (environment !== "production") {
    io.stderr(
      "promote deploys to production; staging is deployed on every merge\n",
    );
    return 1;
  }
  if (describe) {
    const builds = await stagingBuilds(io);
    const listed = Array.isArray(builds) ? builds : [];
    const commit =
      buildId && !listed.some((build) => build.sha === buildId)
        ? await commitOf(io, buildId)
        : undefined;
    io.stdout(`${describePromotion(builds, buildId, commit)}\n`);
    const described = buildId ?? listed[0]?.sha;
    if (described && isBuildId(described) && io.env.GITHUB_OUTPUT)
      await appendFile(io.env.GITHUB_OUTPUT, `build-id=${described}\n`);
    return 0;
  }
  const confirm = typed?.trim();
  if (confirm && !isBuildId(confirm)) {
    io.stderr(
      `${JSON.stringify(confirm)} is not a full commit SHA; production is unchanged\n`,
    );
    return 1;
  }
  if (
    missingVariables([...deploySecrets(config), "TURBO_VIBE_BUILDS_BUCKET"], io)
  )
    return 1;
  const store = new BuildStore(
    io,
    config.project,
    buildsBucket("production", io.env),
  );
  const named = buildId ?? (newest || !confirm ? undefined : confirm);
  const chosen = named
    ? await store.getRecord(named)
    : choosePromotion(await store.listRecords());
  if (!chosen) {
    io.stderr(
      named
        ? `build ${named} has no record; production is unchanged\n`
        : "no staging build has passed its smoke test; production is unchanged\n",
    );
    return 1;
  }
  // The ID reaches the workflow's outputs and its checkout of that commit, so a record cannot inject anything there.
  if (!isBuildId(chosen.buildId)) {
    io.stderr(
      `the build record names ${JSON.stringify(chosen.buildId)} as its build, which is not a full commit SHA; production is unchanged\n`,
    );
    return 1;
  }
  if (chosen.smoke !== "passed") {
    io.stderr(
      `build ${chosen.buildId} has not passed its smoke test (${chosen.smoke}); production is unchanged\n`,
    );
    return 1;
  }
  if (confirm !== undefined && confirm !== chosen.buildId) {
    io.stderr(
      `the build to promote is ${chosen.buildId}, not ${JSON.stringify(confirm)}; production is unchanged. Confirm with ${chosen.buildId} to promote it\n`,
    );
    return 1;
  }
  if (choose) {
    io.stdout(`${chosen.buildId}\n`);
    return 0;
  }
  const appSecrets = appSecretValues(config, environment, io);
  if (!appSecrets) return 1;
  const publicValues = appPublicValues(config, environment, io);
  if (!publicValues) return 1;
  io.stdout(`promote build ${chosen.buildId} to production\n`);
  const infra = await environmentOutputs(config, environment, io);
  if (!infra) return 1;
  if (analyticsTokenMissing(config, environment, infra, io)) return 1;
  const secrets = runtimeSecrets(config, environment, infra, io);
  if (!secrets) return 1;
  const outputs = await deployServices(
    project,
    environment,
    {
      buildId: chosen.buildId,
      dryRun: false,
      secrets,
      appSecrets,
      publicValues,
      outputs: infra,
      store,
      recorded: chosen.services,
    },
    io,
  );
  return typeof outputs === "number" ? outputs : 0;
}

function analyticsTokenMissing(
  config: Config,
  environment: EnvironmentName,
  infra: Readonly<Record<string, unknown>>,
  io: Io,
): boolean {
  if (!analyticsFor(config, environment)) return false;
  const token = infra.analytics_token;
  if (typeof token === "string" && token !== "") return false;
  io.stderr(
    `${environment} counts visits, but its Web Analytics token is not in the infrastructure outputs; run apply first\n`,
  );
  return true;
}

// Only an environment made private with turbo-vibe 1.0 has a service token: newer ones let the probes through.
async function accessHeaders(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<Record<string, string> | undefined | null> {
  if (!accessFor(config, environment)) return undefined;
  const outputs = await readOutputs(config, environment, io);
  if (!outputs) {
    io.stderr(`cannot read the current ${environment} outputs\n`);
    return null;
  }
  const id = outputs.access_client_id;
  const secret = outputs.access_client_secret;
  if (typeof id !== "string" || typeof secret !== "string") return undefined;
  return { "cf-access-client-id": id, "cf-access-client-secret": secret };
}

export async function smoke(
  config: Config,
  environment: EnvironmentName,
  buildId: string,
  io: Io,
): Promise<number> {
  const records = environment === "staging";
  if (records && missingVariables(stateSecrets, io)) return 1;
  const headers = await accessHeaders(config, environment, io);
  if (headers === null) return 1;
  let failed = false;
  for (const context of contexts(config, environment)) {
    const adapter = adapterFor(context.service.target);
    if (!adapter.smoke) continue;
    const result = await adapter.smoke({
      ...context,
      buildId,
      io,
      ...(headers ? { headers } : {}),
    });
    (result.ok ? io.stdout : io.stderr)(
      `${result.ok ? "ok" : "FAIL"} ${context.name}: ${result.message}\n`,
    );
    failed ||= !result.ok;
  }
  if (records) {
    const store = new BuildStore(
      io,
      config.project,
      buildsBucket(environment, io.env),
    );
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
