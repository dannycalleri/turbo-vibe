import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Config,
  type EnvironmentName,
  isPreview,
} from "./config/schema.js";
import type { Io } from "./io.js";

export function appPublic(config: Config): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  for (const [name, service] of Object.entries(config.services)) {
    if (service.kind !== "frontend") continue;
    for (const value of service.public ?? []) {
      declared.set(value, [...(declared.get(value) ?? []), name]);
    }
  }
  return declared;
}

// A public value lands inside the framework's string literals and HTML, where these characters could end a string or open a tag.
export function publicValueProblem(value: string): string | undefined {
  return /["'\\<\r\n]/.test(value)
    ? "a public value cannot hold a quote, a backslash, a < or a line break"
    : undefined;
}

export function appSecrets(config: Config): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  for (const [name, service] of Object.entries(config.services)) {
    if (!("secrets" in service)) continue;
    for (const secret of service.secrets ?? []) {
      declared.set(secret, [...(declared.get(secret) ?? []), name]);
    }
  }
  return declared;
}

// The workflows pass every secret of the environment as one JSON object, because a reusable workflow cannot name a project's own secrets.
function secretsObject(io: Io): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(io.env.TURBO_VIBE_SECRETS ?? "{}");
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function appSecretValues(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Record<string, string> | undefined {
  const object = secretsObject(io);
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of [...appSecrets(config).keys()].sort()) {
    const fromObject = object[name];
    const value =
      io.env[name] || (typeof fromObject === "string" ? fromObject : "");
    if (value) values[name] = value;
    else missing.push(name);
  }
  if (missing.length === 0) return values;
  const github = isPreview(environment) ? "preview" : environment;
  io.stderr(
    `${environment} has no value for ${missing.join(", ")}, declared in turbo-vibe.yaml; store it in the ${github} GitHub environment with \`setup --env ${github}\`\n`,
  );
  return undefined;
}

export const placeholderPrefix = "__TURBO_VIBE_PUBLIC_";
export const placeholder = (name: string) => `${placeholderPrefix}${name}__`;

function variablesObject(io: Io): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(io.env.TURBO_VIBE_VARS ?? "{}");
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function appPublicValues(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Record<string, string> | undefined {
  const object = variablesObject(io);
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const github = isPreview(environment) ? "preview" : environment;
  for (const name of [...appPublic(config).keys()].sort()) {
    const fromObject = object[name];
    const value =
      io.env[name] || (typeof fromObject === "string" ? fromObject : "");
    if (!value) {
      missing.push(name);
      continue;
    }
    const problem = publicValueProblem(value);
    if (problem) {
      io.stderr(`${name} in ${github}: ${problem}\n`);
      return undefined;
    }
    values[name] = value;
  }
  if (missing.length === 0) return values;
  io.stderr(
    `${environment} has no public value for ${missing.join(", ")}, declared in turbo-vibe.yaml; store it as a variable of the ${github} GitHub environment with \`setup --env ${github}\`\n`,
  );
  return undefined;
}

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function text(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

export async function withPublicValues(
  dir: string,
  copy: string,
  values: Readonly<Record<string, string>>,
  io: Io,
): Promise<string | number> {
  await rm(copy, { recursive: true, force: true });
  await mkdir(copy, { recursive: true });
  await cp(dir, copy, { recursive: true, verbatimSymlinks: true });
  for (const path of await files(copy)) {
    const bytes = await readFile(path);
    if (!bytes.includes(placeholderPrefix)) continue;
    const content = text(bytes);
    let left = content ?? bytes.toString("latin1");
    if (content !== undefined) {
      for (const [name, value] of Object.entries(values)) {
        left = left.replaceAll(placeholder(name), () => value);
      }
      await writeFile(path, left);
    }
    const found = left.match(
      new RegExp(`${placeholderPrefix}([A-Z][A-Z0-9_]*)__`),
    );
    if (found || left.includes(placeholderPrefix)) {
      io.stderr(
        `${path.slice(copy.length + 1)} still holds the placeholder for ${found?.[1] ?? "a public value"} after the public values were put in; nothing was shipped\n`,
      );
      return 1;
    }
  }
  return copy;
}
