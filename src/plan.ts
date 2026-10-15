import {
  type Config,
  type EnvironmentName,
  environmentNames,
  type ServiceKind,
} from "./config/schema.js";
import { backendPrefix } from "./contract.js";
import { hostOf, layout } from "./origins.js";

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

export function pathFor(kind: ServiceKind): string | undefined {
  if (kind === "backend") return backendPrefix;
  if (kind === "frontend") return "/";
  return undefined;
}

export function derivePlan(config: Config): EnvironmentPlan[] {
  return environmentNames.map((environment) => {
    const hosts = layout(config, environment);
    const services = Object.entries(config.services).map(
      ([name, service]): PlannedService => {
        const planned: PlannedService = {
          name,
          kind: service.kind,
          target: service.target,
        };
        const path = pathFor(service.kind);
        if (path) planned.url = `https://${hostOf(hosts, service)}${path}`;
        if (service.kind === "frontend" && service.serve_with) {
          planned.servedWith = service.serve_with;
        }
        return planned;
      },
    );
    return { environment, hostname: hosts.hostname, services };
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
