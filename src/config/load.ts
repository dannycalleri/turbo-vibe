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
    const path = pathFor(service.kind);
    if (!path) continue;
    const other = servedAt.get(path);
    if (other) {
      problems.push({
        path: ["services", name],
        message: `services \`${other}\` and \`${name}\` would both be served at ${path}`,
      });
    } else {
      servedAt.set(path, name);
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
  }

  for (const [name, service] of Object.entries(config.services)) {
    const container =
      service.kind === "backend" ? service.container : undefined;
    if (container?.instance_from && (container.max_instances ?? 0) < 2) {
      problems.push({
        path: ["services", name, "container"],
        message: `service \`${name}\` routes requests by ${container.instance_from}, so it needs max_instances of 2 or more: sessions and the default instance share them`,
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
