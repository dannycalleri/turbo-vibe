import type { Config, EnvironmentName } from "../config/schema.js";
import { hostnameFor } from "../plan.js";
import type { Adapter } from "./types.js";

export const defaultCallbackPath = "/api/auth/callback";

export function callbackUrl(
  config: Config,
  environment: EnvironmentName,
): string | undefined {
  const identity = Object.values(config.services).find(
    (service) => service.kind === "identity",
  );
  if (identity?.kind !== "identity") return undefined;
  return `https://${hostnameFor(config, environment)}${identity.callback_path ?? defaultCallbackPath}`;
}

export const workos: Adapter = {
  target: "workos",
  kind: "identity",
  hostsStaticAssets: false,
  secrets: ["WORKOS_API_KEY", "WORKOS_CLIENT_ID"],
  outputs: ["redirect_uris"],
  plan({ config, name, environment, managedRedirectUris }) {
    const callback = callbackUrl(config, environment);
    return {
      workos: {
        [name]: {
          redirect_uris: [
            ...(managedRedirectUris ?? (callback ? [callback] : [])),
          ],
        },
      },
    };
  },
};
