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
  let port: number | undefined;
  for (const line of instructions(dockerfile)) {
    const [keyword = "", ...args] = line.split(/\s+/);
    const instruction = keyword.toUpperCase();
    if (instruction === "FROM") port = undefined;
    if (instruction !== "EXPOSE") continue;
    const tcp = args
      .map((arg) => /^(\d+)(\/tcp)?$/i.exec(arg)?.[1])
      .find((match) => match !== undefined);
    port = tcp ? Number(tcp) : undefined;
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
  const exposed = dockerfile ? exposedPort(dockerfile) : undefined;
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
