import type { BuildStore, Outputs } from "../builds.js";
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
  backendHostname: string;
  managedRedirectUris?: readonly string[];
}

export interface DeployContext extends ServiceContext {
  buildId: string;
  secretNames: readonly string[];
  secrets: Readonly<Record<string, string>>;
  buildEnv: Readonly<Record<string, string | undefined>>;
  outputs: Readonly<Record<string, unknown>>;
  recorded?: Outputs;
  assetsDirs: Readonly<Record<string, string>>;
  store?: BuildStore;
  dryRun: boolean;
  configDir: string;
  workDir: string;
  io: Io;
}

export interface RemoveContext extends ServiceContext {
  io: Io;
}

export interface DeployResult {
  code: number;
  outputs?: Outputs;
  assetsDir?: string;
  unchecked?: boolean;
}

export interface SmokeContext extends ServiceContext {
  buildId: string;
  io: Io;
}

export interface CloudflareInputs {
  workers: Record<string, { routes: string[] }>;
  hostnames: string[];
  cnames?: Record<string, string>;
}

export interface VercelInputs {
  projects: Record<
    string,
    { domain: string; environment: Record<string, string> }
  >;
}

export interface SupabaseInputs {
  organization_id?: string;
  name: string;
  region: string;
  branch_of?: "staging" | "production";
}

export interface WorkosInputs {
  redirect_uris: string[];
}

export interface Infrastructure {
  cloudflare?: CloudflareInputs;
  supabase?: Record<string, SupabaseInputs>;
  workos?: Record<string, WorkosInputs>;
  vercel?: VercelInputs;
}

export interface Adapter {
  target: string;
  kind: ServiceKind;
  hostsStaticAssets: boolean;
  readsOutputs?: boolean;
  buildsOwnOutput?: boolean;
  crossOrigin?: boolean;
  stability?: "beta";
  runsServerCode?: boolean;
  secrets: readonly string[];
  outputs: readonly string[];
  plan(context: ServiceContext): Infrastructure;
  deploy?(context: DeployContext): Promise<DeployResult>;
  smoke?(context: SmokeContext): Promise<SmokeResult>;
  remove?(context: RemoveContext): Promise<number>;
}
