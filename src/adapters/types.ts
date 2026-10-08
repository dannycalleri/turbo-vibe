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
}

export interface DeployContext extends ServiceContext {
  buildId: string;
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

export interface Infrastructure {
  cloudflare?: CloudflareInputs;
}

export interface Adapter {
  target: string;
  kind: ServiceKind;
  hostsStaticAssets: boolean;
  secrets: readonly string[];
  outputs: readonly string[];
  plan(context: ServiceContext): Infrastructure;
  deploy(context: DeployContext): Promise<number>;
  smoke(context: SmokeContext): Promise<SmokeResult>;
}
