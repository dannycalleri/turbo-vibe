import { adapters } from "./adapters/index.js";
import {
  type Access,
  type Config,
  type EnvironmentName,
  isPreview,
  type Service,
} from "./config/schema.js";

function sibling(prefix: string, hostname: string): string {
  const [first, ...rest] = hostname.split(".");
  return `${prefix}-${first}.${rest.join(".")}`;
}

export function hostnameFor(
  config: Config,
  environment: EnvironmentName,
): string {
  if (isPreview(environment)) {
    return sibling(
      environment.slice("preview-".length),
      hostnameFor(config, "staging"),
    );
  }
  const configured = config.environments?.[environment]?.hostname;
  if (configured) return configured;
  return environment === "production"
    ? config.domain
    : `${environment}.${config.domain}`;
}

// A preview is guarded like staging, whose code it runs before merge.
export function accessFor(
  config: Config,
  environment: EnvironmentName,
): Access | undefined {
  return config.environments?.[isPreview(environment) ? "staging" : environment]
    ?.access;
}

export interface Layout {
  hostname: string;
  backendHostname: string;
  crossOrigin: boolean;
}

export function layout(config: Config, environment: EnvironmentName): Layout {
  const hostname = hostnameFor(config, environment);
  const services = Object.values(config.services);
  const crossOrigin =
    services.some((service) => service.kind === "backend") &&
    services.some((service) => adapters[service.target]?.crossOrigin === true);
  const configured = isPreview(environment)
    ? undefined
    : config.environments?.[environment]?.api_hostname;
  const backendHostname = crossOrigin
    ? (configured ??
      (isPreview(environment) ? sibling("api", hostname) : `api.${hostname}`))
    : hostname;
  return { hostname, backendHostname, crossOrigin };
}

export function hostOf(layout: Layout, service: Service): string {
  return service.kind === "backend" ? layout.backendHostname : layout.hostname;
}

export interface OriginSettings {
  allowedOrigins: string[];
  frontendUrl: string;
}

export function originSettings(
  config: Config,
  environment: EnvironmentName,
): OriginSettings | undefined {
  const { hostname, backendHostname, crossOrigin } = layout(
    config,
    environment,
  );
  if (!crossOrigin) return undefined;
  const frontendUrl = `https://${hostname}`;
  return { allowedOrigins: [frontendUrl], frontendUrl };
}

export function parentDomain(hostname: string): string {
  return hostname.slice(hostname.indexOf(".") + 1);
}

export function apiUrl(config: Config, environment: EnvironmentName): string {
  const { backendHostname, crossOrigin } = layout(config, environment);
  return crossOrigin ? `https://${backendHostname}` : "";
}

export function callbackUrl(
  config: Config,
  environment: EnvironmentName,
): string | undefined {
  const identity = Object.values(config.services).find(
    (service) => service.kind === "identity",
  );
  if (identity?.kind !== "identity") return undefined;
  const { backendHostname } = layout(config, environment);
  return `https://${backendHostname}${identity.callback_path}`;
}
