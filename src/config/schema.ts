import { z } from "zod";

export const name = z
  .string()
  .regex(
    /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/,
    "must be lowercase letters, digits, and hyphens, start with a letter, and be at most 63 characters",
  );

export const project = name.max(
  41,
  "must be at most 41 characters, so that its state bucket names fit in Cloudflare's 63",
);

export const hostname = z
  .string()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "must be a lowercase hostname such as example.com",
  );

export const email = z
  .string()
  .regex(
    /^[^@\s]+@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/,
    "must be an email address such as ada@example.com",
  );

const access = z.strictObject({
  emails: z.array(email).min(1, "must list at least one email address"),
});

const environment = z.strictObject({
  hostname: hostname.optional(),
  api_hostname: hostname.optional(),
  access: access.optional(),
  analytics: z.boolean().optional(),
});

const secretNames = z.array(z.string()).optional();

const backend = z.strictObject({
  kind: z.literal("backend"),
  target: z.string(),
  secrets: secretNames,
  paths: z
    .array(
      z
        .string()
        .regex(
          /^\/([A-Za-z0-9._~-]+\/)*$/,
          "must start and end with /, such as /api/",
        ),
    )
    .min(1, "must list at least one path, such as /api/")
    .refine(
      (paths) => new Set(paths).size === paths.length,
      "must not list a path twice",
    )
    .refine(
      (paths) => !paths.some((path) => /\/\.{1,2}\//.test(path)),
      "must not hold a . or .. segment",
    )
    .refine(
      (paths) => !paths.some((path) => path.startsWith("/_turbo-vibe/")),
      "must not claim /_turbo-vibe/, which the kit answers itself",
    )
    .optional(),
  build: z.strictObject({
    dockerfile: z.string().min(1),
    context: z.string().min(1).optional(),
    test: z.string().min(1).optional(),
    secrets: secretNames,
  }),
  container: z
    .strictObject({
      instance_type: z
        .enum([
          "lite",
          "basic",
          "standard-1",
          "standard-2",
          "standard-3",
          "standard-4",
        ])
        .optional(),
      sleep_after: z
        .string()
        .regex(
          /^[1-9][0-9]*(s|m|h)$/,
          "must be a duration such as 30s, 5m, or 1h",
        )
        .optional(),
      max_instances: z.number().int().min(1).optional(),
      health: z
        .string()
        .regex(/^\/(?!\/)[^\s?#]*$/, "must be a path such as /ready")
        .optional(),
      port: z
        .number()
        .int()
        .min(1, "must be a port from 1 to 65535")
        .max(65535, "must be a port from 1 to 65535")
        .optional(),
      instance_from: z
        .string()
        .regex(
          /^(query|header):[A-Za-z0-9_-]+$/,
          "must be query:<parameter> or header:<name>",
        )
        .optional(),
    })
    .optional(),
});

const frontend = z.strictObject({
  kind: z.literal("frontend"),
  target: z.string(),
  secrets: secretNames,
  public: secretNames,
  serve_with: name.optional(),
  not_found: z.enum(["spa", "404-page"]).optional(),
  build: z.strictObject({
    command: z.string().min(1),
    output: z.string().min(1).optional(),
    root: z.string().min(1).optional(),
    test: z.string().min(1).optional(),
    secrets: secretNames,
  }),
});

const database = z.strictObject({
  kind: z.literal("database"),
  target: z.string(),
  organization: z.string().min(1).optional(),
  region: z.string().min(1),
  plan: z.enum(["free", "paid"]).optional(),
  staging: z.enum(["project", "branch"]).optional(),
  workdir: z.string().min(1).optional(),
});

const identity = z.strictObject({
  kind: z.literal("identity"),
  target: z.string(),
  callback_path: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]*$/, "must be a path such as /api/auth/callback")
    .default("/api/auth/callback"),
});

export const serviceKinds = [
  "backend",
  "frontend",
  "database",
  "identity",
] as const;
export type ServiceKind = (typeof serviceKinds)[number];

export const environmentNames = ["staging", "production"] as const;
export type StableEnvironment = (typeof environmentNames)[number];
export type PreviewEnvironment = `preview-${string}`;
export type EnvironmentName = StableEnvironment | PreviewEnvironment;

export function isPreview(
  environment: EnvironmentName,
): environment is PreviewEnvironment {
  return environment.startsWith("preview-");
}

export const configSchema = z.strictObject({
  version: z.literal(1),
  project,
  domain: hostname,
  previews: z.boolean().optional(),
  environments: z
    .strictObject({
      staging: environment.optional(),
      production: environment.optional(),
    })
    .optional(),
  services: z
    .record(
      name,
      z.discriminatedUnion("kind", [backend, frontend, database, identity]),
    )
    .refine((services) => Object.keys(services).length > 0, {
      message: "must list at least one service",
    }),
});

export type Config = z.infer<typeof configSchema>;
export type Access = z.infer<typeof access>;
export type Service = Config["services"][string];

// A preview is guarded like staging, whose code it runs before merge.
export function accessFor(
  config: Config,
  environment: EnvironmentName,
): Access | undefined {
  return config.environments?.[isPreview(environment) ? "staging" : environment]
    ?.access;
}
