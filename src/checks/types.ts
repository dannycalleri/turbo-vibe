import type { Config, EnvironmentName } from "../config/schema.js";
import type { Io } from "../io.js";

export type Severity = "ok" | "warn" | "fail";

export interface Finding {
  check: string;
  severity: Severity;
  message: string;
  fix?: string;
  unset?: readonly string[];
}

export interface CheckContext {
  config: Config;
  environment: EnvironmentName;
  // `setup` checks an environment such as `live` as staging-kind, but its secrets live in the GitHub environment of that name.
  githubEnvironment?: string;
  io: Io;
  nodeVersion: string;
  configDir?: string;
}

export type Check = (context: CheckContext) => Promise<Finding[]>;

export function ok(check: string, message: string): Finding {
  return { check, severity: "ok", message };
}

export function fail(check: string, message: string, fix: string): Finding {
  return { check, severity: "fail", message, fix };
}

export function warn(check: string, message: string, fix?: string): Finding {
  return { check, severity: "warn", message, ...(fix ? { fix } : {}) };
}

export function missing(check: string, variable: string, fix: string): Finding {
  return { ...fail(check, `${variable} is not set`, fix), unset: [variable] };
}
