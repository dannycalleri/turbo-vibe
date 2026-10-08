import { isPreview } from "../config/schema.js";
import type { Adapter } from "./types.js";

export const supabase: Adapter = {
  target: "supabase",
  kind: "database",
  hostsStaticAssets: false,
  secrets: ["SUPABASE_ACCESS_TOKEN"],
  outputs: ["project_ref"],
  plan({ config, name, service, environment }) {
    if (service.kind !== "database")
      throw new Error(`${name} is not a database`);
    const branchOf = isPreview(environment)
      ? service.staging === "branch"
        ? "production"
        : "staging"
      : environment === "staging" && service.staging === "branch"
        ? "production"
        : undefined;
    return {
      supabase: {
        [name]: {
          organization_id: service.organization,
          name: `${config.project}-${name}-${environment}`,
          region: service.region,
          ...(branchOf ? { branch_of: branchOf } : {}),
        },
      },
    };
  },
};
