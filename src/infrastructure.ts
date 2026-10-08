import { fileURLToPath } from "node:url";
import { adapterFor } from "./adapters/index.js";
import type {
  CloudflareInputs,
  Infrastructure,
  SupabaseInputs,
  VercelInputs,
  WorkosInputs,
} from "./adapters/types.js";
import type { Config, EnvironmentName } from "./config/schema.js";
import { hostnameFor } from "./plan.js";

export const stateSecrets = [
  "TURBO_VIBE_STATE_BUCKET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
] as const;

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
  }
  return [...names].sort();
}

export function composeInfrastructure(
  config: Config,
  environment: EnvironmentName,
  managedRedirectUris: Readonly<Record<string, string[]>> = {},
): Infrastructure {
  const hostname = hostnameFor(config, environment);
  let cloudflare: CloudflareInputs | undefined;
  let supabase: Record<string, SupabaseInputs> | undefined;
  let workos: Record<string, WorkosInputs> | undefined;
  let vercel: VercelInputs | undefined;
  for (const [name, service] of Object.entries(config.services)) {
    const contribution = adapterFor(service.target).plan({
      config,
      name,
      service,
      environment,
      hostname,
      ...(managedRedirectUris[name]
        ? { managedRedirectUris: managedRedirectUris[name] }
        : {}),
    });
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
  output?: Record<string, { value: string; sensitive?: boolean }>;
  data?: {
    terraform_remote_state: Record<
      string,
      { backend: "s3"; config: S3Backend }
    >;
  };
}

export function rootModule(
  config: Config,
  environment: EnvironmentName,
  env: Readonly<Record<string, string | undefined>>,
  managedRedirectUris: Readonly<Record<string, string[]>> = {},
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
    };
  }
  for (const [name, inputs] of Object.entries(infrastructure.supabase ?? {})) {
    const { branch_of_production, ...variables } = inputs;
    const module = `supabase_${name}`;
    root.module[module] = { source: supabaseModule, ...variables };
    if (branch_of_production) {
      root.data = {
        terraform_remote_state: {
          production: { backend: "s3", config: backend("production") },
        },
      };
      root.module[module].parent_project_ref =
        `\${data.terraform_remote_state.production.outputs.${module}_project_ref}`;
    } else {
      root.output = {
        ...root.output,
        [`${module}_project_ref`]: {
          value: `\${module.${module}.project_ref}`,
        },
      };
    }
    root.output = {
      ...root.output,
      [`${module}_connection`]: {
        value: `\${module.${module}.connection}`,
        sensitive: true,
      },
    };
  }
  if (infrastructure.vercel) {
    root.module.vercel = {
      source: vercelModule,
      team_id: env.VERCEL_TEAM_ID,
      ...infrastructure.vercel,
    };
    root.output = {
      ...root.output,
      vercel_project_ids: { value: "${module.vercel.project_ids}" },
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
