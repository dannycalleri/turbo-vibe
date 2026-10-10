import type { Adapter } from "./types.js";

export const workos: Adapter = {
  target: "workos",
  kind: "identity",
  hostsStaticAssets: false,
  secrets: ["WORKOS_API_KEY", "WORKOS_CLIENT_ID"],
  outputs: ["redirect_uris"],
  plan({ config, name, backendHostname, managedRedirectUris }) {
    const identity = config.services[name];
    const callback =
      identity?.kind === "identity"
        ? `https://${backendHostname}${identity.callback_path}`
        : undefined;
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
