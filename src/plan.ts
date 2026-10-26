import {
  type Config,
  type EnvironmentName,
  environmentNames,
  type Service,
  type ServiceKind,
} from "./config/schema.js";
import { backendPaths } from "./contract.js";
import { hostOf, layout } from "./origins.js";
import type { BackendPort } from "./port.js";

export interface PlannedService {
  name: string;
  kind: ServiceKind;
  target: string;
  url?: string;
  servedWith?: string;
  paths?: readonly string[];
  port?: BackendPort;
  secrets?: string[];
  publicValues?: string[];
  buildSecrets?: string[];
}

export interface EnvironmentPlan {
  environment: EnvironmentName;
  hostname: string;
  services: PlannedService[];
}

export function pathFor(service: Service): string | undefined {
  if (service.kind === "backend") return backendPaths(service)[0];
  if (service.kind === "frontend") return "/";
  return undefined;
}

export function derivePlan(
  config: Config,
  ports: Readonly<Record<string, BackendPort>> = {},
): EnvironmentPlan[] {
  return environmentNames.map((environment) => {
    const hosts = layout(config, environment);
    const services = Object.entries(config.services).map(
      ([name, service]): PlannedService => {
        const planned: PlannedService = {
          name,
          kind: service.kind,
          target: service.target,
        };
        const path = pathFor(service);
        if (path) planned.url = `https://${hostOf(hosts, service)}${path}`;
        if (service.kind === "backend" && backendPaths(service).length > 1)
          planned.paths = backendPaths(service);
        const port = ports[name];
        if (port) planned.port = port;
        if (service.kind === "frontend" && service.serve_with) {
          planned.servedWith = service.serve_with;
        }
        if ("secrets" in service && service.secrets?.length) {
          planned.secrets = [...service.secrets];
        }
        if (service.kind === "frontend" && service.public?.length) {
          planned.publicValues = [...service.public];
        }
        if (
          (service.kind === "backend" || service.kind === "frontend") &&
          service.build.secrets?.length
        ) {
          planned.buildSecrets = [...service.build.secrets];
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
        const row =
          `  ${service.name}  ${service.kind}  ${service.target}  ${service.url ?? ""}${via}`.trimEnd();
        return [
          row,
          ...(service.paths ? [`    paths: ${service.paths.join(", ")}`] : []),
          ...(service.port
            ? [`    port: ${service.port.port} (${service.port.source})`]
            : []),
          ...(service.secrets
            ? [`    secrets: ${service.secrets.join(", ")}`]
            : []),
          ...(service.publicValues
            ? [`    public: ${service.publicValues.join(", ")}`]
            : []),
          ...(service.buildSecrets
            ? [`    build secrets: ${service.buildSecrets.join(", ")}`]
            : []),
        ].join("\n");
      });
      return [`${environment} (${hostname})`, ...rows].join("\n");
    })
    .join("\n\n");
}
