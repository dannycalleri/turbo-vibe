import type { Config, EnvironmentName } from "./config/schema.js";
import type { Io } from "./io.js";
import { callbackUrl } from "./origins.js";

export interface RedirectUriPlan {
  manage: string[];
  alreadyRegistered: string[];
}

export function redirectUriPlan({
  desired,
  existing,
  managed,
}: {
  desired: readonly string[];
  existing: readonly string[];
  managed: readonly string[];
}): RedirectUriPlan {
  const plan: RedirectUriPlan = { manage: [], alreadyRegistered: [] };
  for (const uri of desired) {
    if (managed.includes(uri) || !existing.includes(uri)) plan.manage.push(uri);
    else plan.alreadyRegistered.push(uri);
  }
  return plan;
}

export async function listRedirectUris(io: Io): Promise<string[]> {
  const uris: string[] = [];
  let after: string | undefined;
  do {
    const url = new URL("https://api.workos.com/user_management/redirect_uris");
    url.searchParams.set("limit", "100");
    url.searchParams.set("order", "asc");
    if (after) url.searchParams.set("after", after);
    const response = await io.fetch(url, {
      headers: { authorization: `Bearer ${io.env.WORKOS_API_KEY}` },
    });
    if (!response.ok) {
      throw new Error(
        `WorkOS answered HTTP ${response.status} listing redirect URIs`,
      );
    }
    const page = (await response.json()) as {
      data: { uri: string }[];
      list_metadata: { after?: string | null };
    };
    uris.push(...page.data.map((entry) => entry.uri));
    after = page.list_metadata.after ?? undefined;
  } while (after);
  return uris;
}

export async function discoverRedirectUris(
  config: Config,
  environment: EnvironmentName,
  outputs: Readonly<Record<string, unknown>>,
  io: Io,
): Promise<Record<string, string[]>> {
  const desired = callbackUrl(config, environment);
  const name = Object.entries(config.services).find(
    ([, service]) => service.kind === "identity",
  )?.[0];
  if (!desired || !name) return {};
  const managed =
    (outputs[`workos_${name}_redirect_uris`] as string[] | undefined) ?? [];
  const plan = redirectUriPlan({
    desired: [desired],
    existing: await listRedirectUris(io),
    managed,
  });
  for (const uri of plan.alreadyRegistered) {
    io.stdout(
      `redirect URI ${uri} is already registered in WorkOS; leaving it as it is\n`,
    );
  }
  return { [name]: plan.manage };
}
