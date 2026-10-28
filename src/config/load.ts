import { readFile } from "node:fs/promises";
import {
  type Document,
  isMap,
  isScalar,
  LineCounter,
  parseDocument,
} from "yaml";
import type { z } from "zod";
import {
  adapters as defaultTargets,
  type TargetCatalog,
} from "../adapters/index.js";
import {
  backendPaths,
  backendPrefix,
  serviceVariables,
  stateSecrets,
  supabaseOrganization,
} from "../contract.js";
import { layout, parentDomain } from "../origins.js";
import { pathFor } from "../plan.js";
import { type Config, configSchema, environmentNames } from "./schema.js";

export interface ConfigProblem {
  line: number;
  message: string;
}

export type LoadResult =
  | { ok: true; config: Config }
  | { ok: false; problems: ConfigProblem[] };

type Path = readonly PropertyKey[];

export async function loadConfigFile(
  file: string,
  catalog: TargetCatalog = defaultTargets,
): Promise<LoadResult> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return {
      ok: false,
      problems: [{ line: 0, message: `cannot read ${file}` }],
    };
  }
  return parseConfig(source, catalog);
}

export function parseConfig(
  source: string,
  catalog: TargetCatalog = defaultTargets,
): LoadResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, uniqueKeys: true });
  const lineAt = (offset: number) => lineCounter.linePos(offset).line;

  if (doc.errors.length > 0) {
    return {
      ok: false,
      problems: doc.errors.map((error) => ({
        line: lineAt(error.pos[0]),
        message: (error.message.split("\n")[0] ?? error.message).replace(
          / at line \d+, column \d+:?$/,
          "",
        ),
      })),
    };
  }

  const input: unknown = doc.toJS();
  const parsed = configSchema.safeParse(input);
  const problems = parsed.success
    ? crossCheck(parsed.data, catalog)
    : parsed.error.issues.flatMap((issue) => describeIssue(issue, input));

  if (problems.length > 0) {
    return {
      ok: false,
      problems: problems
        .map(({ path, key, message }) => ({
          line: lineAt(locate(doc, path, key)),
          message,
        }))
        .sort((a, b) => a.line - b.line),
    };
  }
  return { ok: true, config: parsed.data as Config };
}

interface Located {
  path: Path;
  key?: string;
  message: string;
}

function describeIssue(issue: z.core.$ZodIssue, input: unknown): Located[] {
  const path = issue.path;
  const where = path.length > 0 ? `\`${path.join(".")}\`` : "the file";
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => ({
      path,
      key,
      message: `unknown key \`${[...path, key].join(".")}\``,
    }));
  }
  if (issue.code === "invalid_type" && path.length === 0) {
    return [{ path, message: "the file must be a YAML mapping" }];
  }
  if (path.length > 0 && isMissing(input, path)) {
    return [
      {
        path: path.slice(0, -1),
        message: `missing required field \`${path.join(".")}\``,
      },
    ];
  }
  if (issue.code === "invalid_union" && path.at(-1) === "kind") {
    return [
      {
        path,
        message: `${where} must be one of backend, frontend, database, identity`,
      },
    ];
  }
  return [{ path, message: `${where} ${issue.message}` }];
}

function isMissing(input: unknown, path: Path): boolean {
  let value = input;
  for (const segment of path.slice(0, -1)) {
    if (typeof value !== "object" || value === null) return false;
    value = (value as Record<PropertyKey, unknown>)[segment];
  }
  return (
    typeof value === "object" &&
    value !== null &&
    !Object.hasOwn(value, path.at(-1) as PropertyKey)
  );
}

export function reservedNames(catalog: TargetCatalog = defaultTargets): {
  service: Readonly<Record<string, string>>;
  credentials: Readonly<Record<string, string>>;
} {
  const credentials: Record<string, string> = {
    [supabaseOrganization]: "the Supabase organization's slug",
  };
  for (const name of stateSecrets) {
    credentials[name] = "the state bucket's credentials";
  }
  for (const [target, entry] of Object.entries(catalog)) {
    for (const name of entry.secrets ?? []) {
      credentials[name] ??= `the ${target} target's credentials`;
    }
  }
  return { service: serviceVariables, credentials };
}

function nameProblem(
  name: string,
  reserved: ReturnType<typeof reservedNames>,
): string | undefined {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    return "is not a variable name: use capital letters, digits and underscores, starting with a letter";
  }
  if (name.startsWith("GITHUB_")) {
    return "starts with GITHUB_, which GitHub reserves";
  }
  const rename = `; rename it in the application, such as APP_${name}`;
  const set = reserved.service[name];
  if (set) return `is where turbo-vibe puts ${set} in the service${rename}`;
  const stored = reserved.credentials[name];
  if (stored) {
    return `is where turbo-vibe keeps ${stored} in the same GitHub environments${rename}`;
  }
  if (name.startsWith("TURBO_VIBE_")) {
    return `starts with TURBO_VIBE_, which turbo-vibe keeps for its own settings${rename}`;
  }
  return undefined;
}

function crossCheck(config: Config, catalog: TargetCatalog): Located[] {
  const problems: Located[] = [];
  const available = Object.keys(catalog).join(", ");
  for (const [name, service] of Object.entries(config.services)) {
    const target = catalog[service.target];
    if (!target) {
      problems.push({
        path: ["services", name, "target"],
        message: `service \`${name}\` names unknown target \`${service.target}\`; available targets: ${available}`,
      });
    } else if (target.kind !== service.kind) {
      problems.push({
        path: ["services", name, "target"],
        message: `service \`${name}\` is a ${service.kind} but target \`${service.target}\` runs ${target.kind} services`,
      });
    }
  }

  const servedAt = new Map<string, string>();
  for (const [name, service] of Object.entries(config.services)) {
    const path = pathFor(service);
    if (!path) continue;
    const other = servedAt.get(service.kind);
    if (other) {
      problems.push({
        path: ["services", name],
        message:
          service.kind === "backend"
            ? `services \`${other}\` and \`${name}\` are both backends; a project has at most one`
            : `services \`${other}\` and \`${name}\` would both be served at ${path}`,
      });
    } else {
      servedAt.set(service.kind, name);
    }
  }

  for (const [name, service] of Object.entries(config.services)) {
    const target = catalog[service.target];
    if (service.kind !== "frontend" || !target) continue;
    const field = (key: string) => `\`services.${name}.build.${key}\``;
    if (!target.buildsOwnOutput && !service.build.output) {
      problems.push({
        path: ["services", name, "build"],
        message: `missing required field ${field("output")} for target ${service.target}`,
      });
    }
    if (!target.buildsOwnOutput && service.build.root) {
      problems.push({
        path: ["services", name, "build", "root"],
        message: `${field("root")} applies only to targets that build their own output, not ${service.target}`,
      });
    }
    if (target.buildsOwnOutput && service.build.output) {
      problems.push({
        path: ["services", name, "build", "output"],
        message: `${field("output")} does not apply to ${service.target}, which builds its own output`,
      });
    }
    if (service.not_found && service.target !== "cloudflare-static") {
      problems.push({
        path: ["services", name, "not_found"],
        message: `\`services.${name}.not_found\` applies only to cloudflare-static, not ${service.target}`,
      });
    }
  }

  for (const [name, service] of Object.entries(config.services)) {
    const container =
      service.kind === "backend" ? service.container : undefined;
    if (container?.instance_from && (container.max_instances ?? 0) < 3) {
      problems.push({
        path: ["services", name, "container"],
        message: `service \`${name}\` routes requests by ${container.instance_from}, so it needs max_instances of 3 or more: sessions, the default instance and, during a deploy, the previous build's instances share them`,
      });
    }
    if (
      container?.max_instances &&
      container.max_instances > 1 &&
      !container.instance_from
    ) {
      problems.push({
        path: ["services", name, "container", "max_instances"],
        message: `service \`${name}\` allows ${container.max_instances} instances but sets no instance_from, so every request still goes to one instance`,
      });
    }
  }

  const reserved = reservedNames(catalog);
  const secretOwners = new Map<string, string>();
  for (const [name, service] of Object.entries(config.services)) {
    if (!("secrets" in service)) continue;
    for (const secret of service.secrets ?? []) secretOwners.set(secret, name);
  }
  const publicOwners = new Map<string, string>();
  for (const [name, service] of Object.entries(config.services)) {
    if (service.kind !== "frontend") continue;
    for (const value of service.public ?? []) publicOwners.set(value, name);
  }
  for (const [name, service] of Object.entries(config.services)) {
    if (service.kind !== "backend" && service.kind !== "frontend") continue;
    const seen = new Set<string>();
    for (const secret of service.build.secrets ?? []) {
      const runtime = secretOwners.get(secret);
      const shown = publicOwners.get(secret);
      const problem = seen.has(secret)
        ? "is listed twice"
        : runtime
          ? `\`services.${runtime}.secrets\` already declares; a build secret has one value for every environment, a runtime secret one per environment`
          : shown
            ? `\`services.${shown}.public\` already declares; a value is either secret or public`
            : nameProblem(secret, reserved);
      seen.add(secret);
      if (problem) {
        problems.push({
          path: ["services", name, "build", "secrets"],
          message: `\`services.${name}.build.secrets\` names \`${secret}\`, which ${problem}`,
        });
      }
    }
  }
  for (const [name, service] of Object.entries(config.services)) {
    if (service.kind !== "frontend" || !service.public) continue;
    const seen = new Set<string>();
    for (const value of service.public) {
      const owner = secretOwners.get(value);
      const problem = seen.has(value)
        ? "is listed twice"
        : owner
          ? `\`services.${owner}.secrets\` already declares; a value is either secret or public`
          : nameProblem(value, reserved);
      seen.add(value);
      if (problem) {
        problems.push({
          path: ["services", name, "public"],
          message: `\`services.${name}.public\` names \`${value}\`, which ${problem}`,
        });
      }
    }
  }
  for (const [name, service] of Object.entries(config.services)) {
    if (!("secrets" in service) || !service.secrets) continue;
    const target = catalog[service.target];
    if (service.kind === "frontend" && target && !target.runsServerCode) {
      problems.push({
        path: ["services", name, "secrets"],
        message: `service \`${name}\` (${service.target}) cannot have secrets: its build is public, so a value would reach the browser`,
      });
      continue;
    }
    const seen = new Set<string>();
    for (const secret of service.secrets) {
      const problem = seen.has(secret)
        ? "is listed twice"
        : nameProblem(secret, reserved);
      seen.add(secret);
      if (problem) {
        problems.push({
          path: ["services", name, "secrets"],
          message: `\`services.${name}.secrets\` names \`${secret}\`, which ${problem}`,
        });
      }
    }
  }

  for (const kind of ["database", "identity"] as const) {
    const services = Object.entries(config.services).filter(
      ([, service]) => service.kind === kind,
    );
    for (const [name] of services.slice(1)) {
      problems.push({
        path: ["services", name],
        message: `service \`${name}\` is a second ${kind}; a project has at most one (\`${services[0]?.[0]}\`)`,
      });
    }
  }

  for (const [name, service] of Object.entries(config.services)) {
    if (
      service.kind === "database" &&
      service.staging === "branch" &&
      service.plan !== "paid"
    ) {
      problems.push({
        path: ["services", name, "staging"],
        message: `service \`${name}\` sets staging: branch, which needs a paid Supabase plan (plan: paid)`,
      });
    }
  }

  const claimed = new Map<string, string>();
  for (const environment of environmentNames) {
    const { hostname, backendHostname, crossOrigin } = layout(
      config,
      environment,
    );
    if (
      crossOrigin &&
      !backendHostname.endsWith(`.${parentDomain(hostname)}`)
    ) {
      problems.push({
        path: ["environments"],
        message: `the ${environment} API hostname ${backendHostname} must be under ${parentDomain(hostname)}, like the frontend's ${hostname}, so the browser treats the two as one site and sends the API's sign-in cookie with the frontend's requests`,
      });
    }
    const uses: [string, string][] = [[hostname, environment]];
    if (crossOrigin) uses.push([backendHostname, `the ${environment} API`]);
    for (const [host, use] of uses) {
      const earlier = claimed.get(host);
      if (earlier) {
        problems.push({
          path: ["environments"],
          message: `${earlier} and ${use} both use hostname ${host}`,
        });
      } else {
        claimed.set(host, use);
      }
    }
  }

  for (const [name, service] of Object.entries(config.services)) {
    if (service.kind !== "frontend" || service.serve_with === undefined)
      continue;
    const path = ["services", name, "serve_with"];
    const host = config.services[service.serve_with];
    if (host?.kind !== "backend") {
      problems.push({
        path,
        message: `service \`${name}\` sets serve_with to \`${service.serve_with}\`, which is not a backend service`,
      });
      continue;
    }
    const frontendTarget = catalog[service.target];
    const hostTarget = catalog[host.target];
    if (
      frontendTarget &&
      hostTarget &&
      !(frontendTarget.hostsStaticAssets && hostTarget.hostsStaticAssets)
    ) {
      problems.push({
        path,
        message: `service \`${name}\` (${service.target}) cannot be served with \`${service.serve_with}\` (${host.target})`,
      });
    }
  }
  const backend = Object.entries(config.services).find(
    ([, service]) => service.kind === "backend",
  );
  if (backend?.[1].kind === "backend") {
    const [name, service] = backend;
    const paths = backendPaths(service);
    const sharing = Object.entries(config.services).find(
      ([, other]) =>
        other.kind === "frontend" && !catalog[other.target]?.crossOrigin,
    );
    if (paths.includes("/") && sharing) {
      problems.push({
        path: ["services", name, "paths"],
        message: `service \`${name}\` takes every path with /, so frontend \`${sharing[0]}\` on the same hostname would receive no request`,
      });
    }
    for (const [identity, other] of Object.entries(config.services)) {
      if (other.kind !== "identity") continue;
      if (paths.some((path) => other.callback_path.startsWith(path))) continue;
      problems.push({
        path: ["services", identity, "callback_path"],
        message: `service \`${identity}\` has callback_path ${other.callback_path}, which backend \`${name}\` does not answer; put it under ${paths.join(" or ")}`,
      });
    }
  } else {
    for (const [identity, other] of Object.entries(config.services)) {
      if (other.kind !== "identity") continue;
      if (other.callback_path.startsWith(backendPrefix)) continue;
      problems.push({
        path: ["services", identity, "callback_path"],
        message: `service \`${identity}\` has callback_path ${other.callback_path}; without a backend, the app answers the callback under ${backendPrefix}`,
      });
    }
  }
  for (const environment of environmentNames) {
    if (!config.environments?.[environment]?.access) continue;
    const frontend = Object.entries(config.services).find(
      ([, service]) => catalog[service.target]?.crossOrigin,
    );
    const backend = Object.entries(config.services).find(
      ([, service]) =>
        service.kind === "backend" && service.target.startsWith("cloudflare-"),
    );
    if (frontend && backend) {
      problems.push({
        path: ["environments", environment, "access"],
        message: `${environment} cannot be private: frontend \`${frontend[0]}\` on ${frontend[1].target} calling backend \`${backend[0]}\` on ${backend[1].target} from another origin is not supported yet`,
      });
    }
  }
  for (const environment of environmentNames) {
    if (!config.environments?.[environment]?.analytics) continue;
    const pages = Object.values(config.services).some(
      (service) => service.target === "cloudflare-static",
    );
    if (!pages) {
      problems.push({
        path: ["environments", environment, "analytics"],
        message: `analytics counts the pages of a cloudflare-static frontend, and this project has none`,
      });
    }
  }
  return problems;
}

function locate(doc: Document, path: Path, key?: string): number {
  const full = key === undefined ? path : [...path, key];
  for (let depth = full.length; depth > 0; depth--) {
    const parentPath = full.slice(0, depth - 1);
    const parent =
      parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
    if (!isMap(parent)) continue;
    const pair = parent.items.find(
      (item) => isScalar(item.key) && item.key.value === full[depth - 1],
    );
    if (isScalar(pair?.key) && pair.key.range) return pair.key.range[0];
  }
  return doc.contents?.range?.[0] ?? 0;
}
