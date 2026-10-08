import type {
  Config,
  EnvironmentName,
  Service,
  ServiceKind,
} from "../config/schema.js";
import type { Io } from "../io.js";
import type { SmokeResult } from "../smoke.js";

export interface ServiceContext {
  config: Config;
  name: string;
  service: Service;
  environment: EnvironmentName;
  hostname: string;
  managedRedirectUris?: readonly string[];
}

export interface DeployContext extends ServiceContext {
  buildId: string;
  secretNames: readonly string[];
  secrets: Readonly<Record<string, string>>;
  buildEnv: Readonly<Record<string, string | undefined>>;
  dryRun: boolean;
  configDir: string;
  workDir: string;
  io: Io;
}

export interface SmokeContext extends ServiceContext {
  buildId: string;
  io: Io;
}

export interface CloudflareInputs {
  workers: Record<string, { routes: string[] }>;
  hostnames: string[];
}

export interface SupabaseInputs {
  organization_id: string;
  name: string;
  region: string;
  branch_of_production: boolean;
}

export interface WorkosInputs {
  redirect_uris: string[];
}

export interface Infrastructure {
  cloudflare?: CloudflareInputs;
  supabase?: Record<string, SupabaseInputs>;
  workos?: Record<string, WorkosInputs>;
}

export interface Adapter {
  target: string;
  kind: ServiceKind;
  hostsStaticAssets: boolean;
  secrets: readonly string[];
  outputs: readonly string[];
  plan(context: ServiceContext): Infrastructure;
  deploy?(context: DeployContext): Promise<number>;
  smoke?(context: SmokeContext): Promise<SmokeResult>;
}
