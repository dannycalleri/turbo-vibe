import { readFile } from "node:fs/promises";
import {
  type Document,
  isMap,
  isScalar,
  LineCounter,
  parseDocument,
} from "yaml";
import type { z } from "zod";
import { hostnameFor, pathFor } from "../plan.js";
import { targets as defaultTargets, type TargetCatalog } from "../targets.js";
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

  const [staging, production] = environmentNames.map((environment) =>
    hostnameFor(config, environment),
  );
  if (staging === production) {
    problems.push({
      path: ["environments"],
      message: `staging and production both use hostname ${staging}`,
    });
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
