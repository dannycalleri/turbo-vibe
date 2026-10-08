import { fileURLToPath } from "node:url";
import { adapterFor } from "./adapters/index.js";
import type { CloudflareInputs, Infrastructure } from "./adapters/types.js";
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
): Infrastructure {
  const hostname = hostnameFor(config, environment);
  let cloudflare: CloudflareInputs | undefined;
  for (const [name, service] of Object.entries(config.services)) {
    const contribution = adapterFor(service.target).plan({
      config,
      name,
      service,
      environment,
      hostname,
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
    }
  }
  return cloudflare ? { cloudflare } : {};
}

export interface RootModule {
  terraform: { backend: { s3: Record<string, unknown> & { key: string } } };
  module: {
    cloudflare?: CloudflareInputs & {
      source: string;
      account_id: string | undefined;
      zone_id: string | undefined;
    };
  };
}

export function rootModule(
  config: Config,
  environment: EnvironmentName,
  env: Readonly<Record<string, string | undefined>>,
): RootModule {
  const infrastructure = composeInfrastructure(config, environment);
  const module: RootModule["module"] = {};
  if (infrastructure.cloudflare) {
    module.cloudflare = {
      source: cloudflareModule,
      account_id: env.CLOUDFLARE_ACCOUNT_ID,
      zone_id: env.CLOUDFLARE_ZONE_ID,
      ...infrastructure.cloudflare,
    };
  }
  return {
    terraform: {
      backend: {
        s3: {
          bucket: env.TURBO_VIBE_STATE_BUCKET,
          key: stateKey(config.project, environment),
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
        },
      },
    },
    module,
  };
}
