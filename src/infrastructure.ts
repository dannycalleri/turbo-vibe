import { fileURLToPath } from "node:url";
import { adapterFor } from "./adapters/index.js";
import type {
  CloudflareInputs,
  Infrastructure,
  SupabaseInputs,
  VercelInputs,
  WorkosInputs,
} from "./adapters/types.js";
import { buildIdPath, kitHealthPath } from "./adapters/wrangler.js";
import {
  accessFor,
  type Config,
  type EnvironmentName,
  isPreview,
} from "./config/schema.js";
import { stateSecrets, supabaseOrganization } from "./contract.js";
import { analyticsFor, hostOf, layout, originSettings } from "./origins.js";

const cloudflareModule = fileURLToPath(
  new URL("../infra/cloudflare", import.meta.url),
);
const supabaseModule = fileURLToPath(
  new URL("../infra/supabase", import.meta.url),
);
const vercelModule = fileURLToPath(new URL("../infra/vercel", import.meta.url));
const workosModule = fileURLToPath(new URL("../infra/workos", import.meta.url));

export function stateKey(
  project: string,
  environment: EnvironmentName,
): string {
  return `${project}/${environment}/terraform.tfstate`;
}

export function requiredSecrets(config: Config): string[] {
  const names = new Set<string>(stateSecrets);
  for (const service of Object.values(config.services)) {
    for (const name of adapterFor(service.target).secrets) names.add(name);
    if (service.kind === "database" && !service.organization)
      names.add(supabaseOrganization);
  }
  return [...names].sort();
}

export function contributions(
  config: Config,
  environment: EnvironmentName,
  managedRedirectUris: Readonly<Record<string, string[]>> = {},
): [string, Infrastructure][] {
  const hosts = layout(config, environment);
  const origins = originSettings(config, environment);
  return Object.entries(config.services).map(([name, service]) => [
    name,
    adapterFor(service.target).plan({
      config,
      name,
      service,
      environment,
      hostname: hostOf(hosts, service),
      backendHostname: hosts.backendHostname,
      ...(origins ? { allowedOrigins: origins.allowedOrigins } : {}),
      ...(managedRedirectUris[name]
        ? { managedRedirectUris: managedRedirectUris[name] }
        : {}),
    }),
  ]);
}

export function composeInfrastructure(
  config: Config,
  environment: EnvironmentName,
  managedRedirectUris: Readonly<Record<string, string[]>> = {},
): Infrastructure {
  let cloudflare: CloudflareInputs | undefined;
  let supabase: Record<string, SupabaseInputs> | undefined;
  let workos: Record<string, WorkosInputs> | undefined;
  let vercel: VercelInputs | undefined;
  for (const [, contribution] of contributions(
    config,
    environment,
    managedRedirectUris,
  )) {
    if (contribution.cloudflare) {
      cloudflare ??= { workers: {}, hostnames: [] };
      Object.assign(cloudflare.workers, contribution.cloudflare.workers);
      cloudflare.hostnames = [
        ...new Set([
          ...cloudflare.hostnames,
          ...contribution.cloudflare.hostnames,
        ]),
      ];
      if (contribution.cloudflare.cnames) {
        cloudflare.cnames = {
          ...cloudflare.cnames,
          ...contribution.cloudflare.cnames,
        };
      }
    }
    if (contribution.vercel) {
      vercel = {
        projects: { ...vercel?.projects, ...contribution.vercel.projects },
      };
    }
    if (contribution.supabase) {
      supabase = { ...supabase, ...contribution.supabase };
    }
    if (contribution.workos) {
      workos = { ...workos, ...contribution.workos };
    }
  }
  return {
    ...(cloudflare ? { cloudflare } : {}),
    ...(supabase ? { supabase } : {}),
    ...(workos ? { workos } : {}),
    ...(vercel ? { vercel } : {}),
  };
}

type S3Backend = Record<string, unknown> & { key: string };

export interface RootModule {
  terraform: { backend: { s3: S3Backend } };
  module: Record<string, { source: string } & Record<string, unknown>>;
  variable?: Record<
    string,
    { type: string; sensitive: boolean; default: Record<string, never> }
  >;
  output?: Record<string, { value: string; sensitive?: boolean }>;
}

export const bypassVariable = "vercel_protection_bypass";

export function privateVercelProjects(
  config: Config,
  environment: EnvironmentName,
): string[] {
  if (!accessFor(config, environment)) return [];
  return Object.keys(
    composeInfrastructure(config, environment).vercel?.projects ?? {},
  );
}

export interface BranchedDatabase {
  module: string;
  parent: "staging" | "production";
  parentName: string;
  organization?: string;
}

export function branchedDatabases(
  config: Config,
  environment: EnvironmentName,
  env: Readonly<Record<string, string | undefined>> = {},
): BranchedDatabase[] {
  const supabase = composeInfrastructure(config, environment).supabase ?? {};
  return Object.entries(supabase).flatMap(([name, inputs]) => {
    if (!inputs.branch_of) return [];
    const organization = inputs.organization_id ?? env.SUPABASE_ORGANIZATION;
    return [
      {
        module: `supabase_${name}`,
        parent: inputs.branch_of,
        parentName: `${config.project}-${name}-${inputs.branch_of}`,
        ...(organization ? { organization } : {}),
      },
    ];
  });
}

export function rootModule(
  config: Config,
  environment: EnvironmentName,
  env: Readonly<Record<string, string | undefined>>,
  managedRedirectUris: Readonly<Record<string, string[]>> = {},
  parentRefs: Readonly<Record<string, string>> = {},
  accessOnAccount = false,
): RootModule {
  const infrastructure = composeInfrastructure(
    config,
    environment,
    managedRedirectUris,
  );
  const backend = (stateOf: EnvironmentName): S3Backend => ({
    bucket: env.TURBO_VIBE_STATE_BUCKET,
    key: stateKey(config.project, stateOf),
    region: "auto",
    endpoints: {
      s3: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    },
    use_lockfile: true,
    use_path_style: true,
    skip_credentials_validation: true,
    skip_region_validation: true,
    skip_requesting_account_id: true,
    skip_metadata_api_check: true,
    skip_s3_checksum: true,
  });
  const root: RootModule = {
    terraform: { backend: { s3: backend(environment) } },
    module: {},
  };
  if (infrastructure.cloudflare) {
    root.module.cloudflare = {
      source: cloudflareModule,
      account_id: env.CLOUDFLARE_ACCOUNT_ID,
      zone_id: env.CLOUDFLARE_ZONE_ID,
      ...infrastructure.cloudflare,
      ...(infrastructure.cloudflare.hostnames.length > 0 &&
      !isPreview(environment)
        ? { always_use_https: true }
        : {}),
    };
    if (
      analyticsFor(config, environment) &&
      infrastructure.cloudflare.hostnames.length > 0
    ) {
      root.module.cloudflare.analytics_host = layout(
        config,
        environment,
      ).hostname;
      root.output = {
        ...root.output,
        analytics_token: { value: `\${module.cloudflare.analytics_token}` },
      };
    }
    const access = accessFor(config, environment);
    if (access && infrastructure.cloudflare.hostnames.length > 0) {
      root.module.cloudflare.access = {
        name: `${config.project}-${environment}`,
        domains: infrastructure.cloudflare.hostnames,
        emails: access.emails,
        public_paths: [buildIdPath, kitHealthPath],
        ...(accessOnAccount ? { on_account: true } : {}),
        ...(layout(config, environment).crossOrigin
          ? { preflight_bypass: true }
          : {}),
      };
      root.output = {
        ...root.output,
        access_on_account: {
          value: `\${module.cloudflare.access_on_account}`,
        },
        access_client_id: { value: `\${module.cloudflare.access_client_id}` },
        access_client_secret: {
          value: `\${module.cloudflare.access_client_secret}`,
          sensitive: true,
        },
      };
    }
  }
  for (const [name, inputs] of Object.entries(infrastructure.supabase ?? {})) {
    const { branch_of, ...variables } = inputs;
    const module = `supabase_${name}`;
    root.module[module] = {
      source: supabaseModule,
      organization_id: env.SUPABASE_ORGANIZATION,
      ...variables,
    };
    const parentRef = branch_of && parentRefs[module];
    if (parentRef) root.module[module].parent_project_ref = parentRef;
    root.output = {
      ...root.output,
      [`${module}_connection`]: {
        value: `\${module.${module}.connection}`,
        sensitive: true,
      },
    };
  }
  if (infrastructure.vercel) {
    const access = accessFor(config, environment);
    root.module.vercel = {
      source: vercelModule,
      team_id: env.VERCEL_TEAM_ID,
      projects: access
        ? Object.fromEntries(
            Object.entries(infrastructure.vercel.projects).map(
              ([name, project]) => [name, { ...project, private: true }],
            ),
          )
        : infrastructure.vercel.projects,
      ...(access ? { bypass_secrets: `\${var.${bypassVariable}}` } : {}),
    };
    if (access)
      root.variable = {
        [bypassVariable]: { type: "map(string)", sensitive: true, default: {} },
      };
    root.output = {
      ...root.output,
      vercel_project_ids: { value: `\${module.vercel.project_ids}` },
      ...(access
        ? {
            vercel_protection_bypass: {
              value: `\${module.vercel.protection_bypass}`,
              sensitive: true,
            },
          }
        : {}),
    };
  }
  for (const [name, inputs] of Object.entries(infrastructure.workos ?? {})) {
    const module = `workos_${name}`;
    root.module[module] = { source: workosModule, ...inputs };
    root.output = {
      ...root.output,
      [`${module}_redirect_uris`]: {
        value: `\${module.${module}.redirect_uris}`,
      },
    };
  }
  return root;
}
