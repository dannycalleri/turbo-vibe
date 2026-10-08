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

const environment = z.strictObject({ hostname: hostname.optional() });

const backend = z.strictObject({
  kind: z.literal("backend"),
  target: z.string(),
  build: z.strictObject({
    dockerfile: z.string().min(1),
    context: z.string().min(1).optional(),
    test: z.string().min(1).optional(),
  }),
});

const frontend = z.strictObject({
  kind: z.literal("frontend"),
  target: z.string(),
  serve_with: name.optional(),
  build: z.strictObject({
    command: z.string().min(1),
    output: z.string().min(1),
    test: z.string().min(1).optional(),
  }),
});

const database = z.strictObject({
  kind: z.literal("database"),
  target: z.string(),
});

const identity = z.strictObject({
  kind: z.literal("identity"),
  target: z.string(),
});

export const serviceKinds = [
  "backend",
  "frontend",
  "database",
  "identity",
] as const;
export type ServiceKind = (typeof serviceKinds)[number];

export const environmentNames = ["staging", "production"] as const;
export type EnvironmentName = (typeof environmentNames)[number];

export const configSchema = z.strictObject({
  version: z.literal(1),
  project: name,
  domain: hostname,
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
