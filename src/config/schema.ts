import { z } from "zod";

const name = z
  .string()
  .regex(
    /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/,
    "must be lowercase letters, digits, and hyphens, start with a letter, and be at most 63 characters",
  );

const hostname = z
  .string()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "must be a lowercase hostname such as example.com",
  );

const environment = z.strictObject({
  hostname: hostname.optional(),
  api_hostname: hostname.optional(),
});

const backend = z.strictObject({
  kind: z.literal("backend"),
  target: z.string(),
  build: z.strictObject({
    dockerfile: z.string().min(1),
    context: z.string().min(1).optional(),
    test: z.string().min(1).optional(),
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
  serve_with: name.optional(),
  build: z.strictObject({
    command: z.string().min(1),
    output: z.string().min(1).optional(),
    root: z.string().min(1).optional(),
    test: z.string().min(1).optional(),
  }),
});

const database = z.strictObject({
  kind: z.literal("database"),
  target: z.string(),
  organization: z.string().min(1),
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
    .regex(
      /^\/api\/[A-Za-z0-9/_-]*$/,
      "must be a path under /api/, where the backend answers",
    )
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
  project: name,
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
export type Service = Config["services"][string];
