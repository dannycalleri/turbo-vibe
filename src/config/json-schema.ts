import { z } from "zod";
import { adapters } from "../adapters/index.js";
import { configSchema } from "./schema.js";

export const schemaUrl = (major: string) =>
  `https://unpkg.com/@turbo-vibe/cli@${major}/schema/turbo-vibe.schema.json`;

interface Node {
  properties?: Record<string, Node>;
  additionalProperties?: Node | boolean;
  oneOf?: Node[];
  const?: unknown;
  enum?: unknown[];
}

export function jsonSchema(major: string): object {
  const generated = z.toJSONSchema(configSchema, { io: "input" }) as Node;
  const services = generated.properties?.services?.additionalProperties;
  for (const variant of (typeof services === "object" && services.oneOf) ||
    []) {
    const kind = variant.properties?.kind?.const;
    const target = variant.properties?.target;
    if (target)
      target.enum = Object.values(adapters)
        .filter((adapter) => adapter.kind === kind)
        .map((adapter) => adapter.target);
  }
  return { $id: schemaUrl(major), title: "turbo-vibe.yaml", ...generated };
}
