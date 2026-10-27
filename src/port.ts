import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Config, Service } from "./config/schema.js";
import { defaultBackendPort } from "./contract.js";

type Backend = Extract<Service, { kind: "backend" }>;

export interface BackendPort {
  port: number;
  source: string;
}

function instructions(dockerfile: string): string[] {
  return dockerfile
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function exposedPort(dockerfile: string): number | undefined {
  const stages = new Map<string, number | undefined>();
  let stage: string | undefined;
  let port: number | undefined;
  for (const line of instructions(dockerfile)) {
    const [keyword = "", ...args] = line.split(/\s+/);
    const instruction = keyword.toUpperCase();
    if (instruction === "FROM") {
      if (stage) stages.set(stage, port);
      const [base = "", as, name] = args.filter((arg) => !arg.startsWith("--"));
      port = stages.get(base.toLowerCase());
      stage = as?.toUpperCase() === "AS" ? name?.toLowerCase() : undefined;
      continue;
    }
    if (instruction !== "EXPOSE") continue;
    const tcp = args
      .map((arg) => /^(\d+)(\/tcp)?$/i.exec(arg)?.[1])
      .find((match) => match !== undefined);
    if (tcp) port = Number(tcp);
  }
  return port;
}

export async function backendPort(
  backend: Backend,
  configDir: string,
): Promise<BackendPort> {
  if (backend.container?.port) {
    return { port: backend.container.port, source: "container.port" };
  }
  const dockerfile = await readFile(
    resolve(configDir, backend.build.dockerfile),
    "utf8",
  ).catch(() => undefined);
  if (dockerfile === undefined)
    return {
      port: defaultBackendPort,
      source: `the default; cannot read ${backend.build.dockerfile}`,
    };
  const exposed = exposedPort(dockerfile);
  if (exposed) {
    return { port: exposed, source: `EXPOSE in ${backend.build.dockerfile}` };
  }
  return { port: defaultBackendPort, source: "the default" };
}

export async function backendPorts(
  config: Config,
  configDir: string,
): Promise<Record<string, BackendPort>> {
  const ports: Record<string, BackendPort> = {};
  for (const [name, service] of Object.entries(config.services)) {
    if (service.kind === "backend" && service.target === "cloudflare-container")
      ports[name] = await backendPort(service, configDir);
  }
  return ports;
}
