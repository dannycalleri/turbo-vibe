import {
  type Config,
  type EnvironmentName,
  isPreview,
} from "./config/schema.js";
import type { Io } from "./io.js";

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
