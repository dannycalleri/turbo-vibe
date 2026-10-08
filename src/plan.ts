import {
  type Config,
  type EnvironmentName,
  environmentNames,
  type ServiceKind,
} from "./config/schema.js";

export interface PlannedService {
  name: string;
  kind: ServiceKind;
  target: string;
  url?: string;
  servedWith?: string;
}

export interface EnvironmentPlan {
  environment: EnvironmentName;
  hostname: string;
  services: PlannedService[];
}

export function hostnameFor(
  config: Config,
  environment: EnvironmentName,
): string {
  const configured = config.environments?.[environment]?.hostname;
  if (configured) return configured;
  return environment === "production"
    ? config.domain
    : `${environment}.${config.domain}`;
}

export function pathFor(kind: ServiceKind): string | undefined {
  if (kind === "backend") return "/api/";
  if (kind === "frontend") return "/";
  return undefined;
}

export function derivePlan(config: Config): EnvironmentPlan[] {
  return environmentNames.map((environment) => {
    const hostname = hostnameFor(config, environment);
    const services = Object.entries(config.services).map(
      ([name, service]): PlannedService => {
        const planned: PlannedService = {
          name,
          kind: service.kind,
          target: service.target,
        };
        const path = pathFor(service.kind);
        if (path) planned.url = `https://${hostname}${path}`;
        if (service.kind === "frontend" && service.serve_with) {
          planned.servedWith = service.serve_with;
        }
        return planned;
      },
    );
    return { environment, hostname, services };
  });
}

export function formatPlan(plan: EnvironmentPlan[]): string {
  return plan
    .map(({ environment, hostname, services }) => {
      const rows = services.map((service) => {
        const via = service.servedWith
          ? ` (served with ${service.servedWith})`
          : "";
        return `  ${service.name}  ${service.kind}  ${service.target}  ${service.url ?? ""}${via}`.trimEnd();
      });
      return [`${environment} (${hostname})`, ...rows].join("\n");
    })
    .join("\n\n");
}
