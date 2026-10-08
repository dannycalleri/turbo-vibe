import type {
  Config,
  EnvironmentName,
  Service,
  ServiceKind,
} from "../config/schema.js";

export interface ServiceContext {
  config: Config;
  name: string;
  service: Service;
  environment: EnvironmentName;
  hostname: string;
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
}
