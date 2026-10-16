import { adapterFor } from "../adapters/index.js";
import {
  type Config,
  type EnvironmentName,
  environmentNames,
  isPreview,
} from "../config/schema.js";
import { accessFor } from "../origins.js";
import type { Check, CheckContext, Finding } from "./types.js";
import { fail, missing, ok, warn } from "./types.js";

const api = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  success: boolean;
  result: T;
}

async function get<T>(
  { io }: CheckContext,
  path: string,
): Promise<{ status: number; body?: Envelope<T> }> {
  const response = await io.fetch(`${api}${path}`, {
    headers: { authorization: `Bearer ${io.env.CLOUDFLARE_API_TOKEN}` },
  });
  const body = (await response.json().catch(() => undefined)) as
    | Envelope<T>
    | undefined;
  return { status: response.status, ...(body ? { body } : {}) };
}

interface Policy {
  effect?: string;
  resources?: Record<string, unknown>;
  permission_groups?: { name: string }[];
}

export const zeroTrustPage = "https://one.dash.cloudflare.com/";

const accessPermissions = [
  "Access: Apps and Policies Write",
  "Access: Service Tokens Write",
];

export function hasPrivateEnvironment(config: Config): boolean {
  return environmentNames.some((environment) => accessFor(config, environment));
}

export const zoneScoped: ReadonlySet<string> = new Set([
  "DNS Write",
  "Workers Routes Write",
  "Zone Settings Write",
]);

export function covers(
  resources: Record<string, unknown>,
  permission: string,
  ids: { account: string; zone: string },
): boolean {
  const account = `com.cloudflare.api.account.${ids.account}`;
  const allAccounts = "com.cloudflare.api.account.*";
  const zoneKeys = [
    `com.cloudflare.api.account.zone.${ids.zone}`,
    "com.cloudflare.api.account.zone.*",
  ];
  if (!zoneScoped.has(permission))
    return account in resources || allAccounts in resources;
  if (zoneKeys.some((key) => key in resources)) return true;
  return [account, allAccounts].some((key) => {
    const nested = resources[key];
    return (
      typeof nested === "object" &&
      nested !== null &&
      zoneKeys.some((zone) => zone in nested)
    );
  });
}

export function granted(
  policies: readonly Policy[],
  permission: string,
  ids: { account: string; zone: string },
): boolean {
  const matching = policies.filter(
    (policy) =>
      (policy.permission_groups ?? []).some(
        (group) => group.name === permission,
      ) && covers(policy.resources ?? {}, permission, ids),
  );
  return (
    matching.some((policy) => policy.effect === "allow") &&
    !matching.some((policy) => policy.effect === "deny")
  );
}

export interface Subscription {
  rate_plan?: { id?: string; public_name?: string };
}

export function onWorkersPaid(subscriptions: readonly Subscription[]): boolean {
  return subscriptions.some((subscription) => {
    const plan =
      `${subscription.rate_plan?.id ?? ""} ${subscription.rate_plan?.public_name ?? ""}`.toLowerCase();
    return plan.includes("workers") && plan.includes("paid");
  });
}

// Pull-request code runs with the preview token, so it must not change zone-wide settings.
function managesZoneSettings(environment: string): boolean {
  return (
    environment !== "preview" && !isPreview(environment as EnvironmentName)
  );
}

export function requiredPermissions(context: {
  config: CheckContext["config"];
  environment: string;
  githubEnvironment?: string;
}): string[] {
  const targets = new Set(
    Object.values(context.config.services).map((service) => service.target),
  );
  const needed = new Set<string>();
  if (
    [...targets].some((target) =>
      adapterFor(target).secrets.includes("CLOUDFLARE_ZONE_ID"),
    )
  ) {
    needed.add("DNS Write");
  }
  if (targets.has("cloudflare-container") || targets.has("cloudflare-static")) {
    needed.add("Workers Scripts Write");
    needed.add("Workers Routes Write");
    if (managesZoneSettings(context.githubEnvironment ?? context.environment))
      needed.add("Zone Settings Write");
  }
  if (targets.has("cloudflare-container"))
    needed.add("Workers Containers Write");
  // Every environment but production deploys like staging: `preview`, `live` and each preview inherit its access.
  const name = context.githubEnvironment ?? context.environment;
  if (
    accessFor(context.config, name === "production" ? "production" : "staging")
  )
    for (const permission of accessPermissions) needed.add(permission);
  return [...needed];
}

export const cloudflare: Check = async (context) => {
  const { io, config } = context;
  const findings: Finding[] = [];
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID"]) {
    if (!io.env[name])
      findings.push(
        missing(
          "cloudflare",
          name,
          `set ${name} on the ${context.environment} GitHub environment`,
        ),
      );
  }
  if (findings.length > 0) return findings;

  let tokens = "/user/tokens";
  let verified = await get<{ id: string; status: string }>(
    context,
    `${tokens}/verify`,
  );
  if (
    verified.body?.result?.status !== "active" &&
    io.env.CLOUDFLARE_ACCOUNT_ID
  ) {
    tokens = `/accounts/${io.env.CLOUDFLARE_ACCOUNT_ID}/tokens`;
    verified = await get(context, `${tokens}/verify`);
  }
  if (verified.body?.result?.status !== "active") {
    return [
      fail(
        "cloudflare",
        "CLOUDFLARE_API_TOKEN is not a valid, active API token",
        "create a token in Cloudflare → Manage Account → Account API Tokens and set it as CLOUDFLARE_API_TOKEN",
      ),
    ];
  }
  const accountOwned = tokens !== "/user/tokens";
  const tokenPage = accountOwned
    ? "Manage Account → Account API Tokens"
    : "My Profile → API Tokens";
  findings.push(ok("cloudflare", "CLOUDFLARE_API_TOKEN is active"));

  const zone = await get<{
    name: string;
    status: string;
    name_servers?: string[];
  }>(context, `/zones/${io.env.CLOUDFLARE_ZONE_ID}`);
  const zoneName = zone.body?.result?.name;
  if (!zoneName) {
    findings.push(
      fail(
        "cloudflare",
        `CLOUDFLARE_API_TOKEN cannot read zone CLOUDFLARE_ZONE_ID (HTTP ${zone.status})`,
        `check CLOUDFLARE_ZONE_ID is the zone of ${config.domain}, and that the token's zone resources include it`,
      ),
    );
  } else if (
    config.domain !== zoneName &&
    !config.domain.endsWith(`.${zoneName}`)
  ) {
    findings.push(
      fail(
        "cloudflare",
        `zone ${zoneName} does not contain the project's domain ${config.domain}`,
        `set CLOUDFLARE_ZONE_ID to the zone that holds ${config.domain}`,
      ),
    );
  } else if (zone.body?.result?.status !== "active") {
    findings.push(
      fail(
        "cloudflare",
        `zone ${zoneName} is ${zone.body?.result?.status}, not active`,
        `point ${zoneName}'s nameservers at Cloudflare (${(zone.body?.result?.name_servers ?? []).join(", ")}) at your registrar`,
      ),
    );
  } else {
    findings.push(
      ok("cloudflare", `zone ${zoneName} is active and holds ${config.domain}`),
    );
  }

  let accessGranted = true;
  const token = await get<{ policies?: Policy[] }>(
    context,
    `${tokens}/${verified.body.result.id}`,
  );
  if (!token.body?.result?.policies) {
    findings.push(
      fail(
        "cloudflare",
        "CLOUDFLARE_API_TOKEN cannot read its own permissions, so check cannot confirm them",
        accountOwned
          ? "add the Account → Account API Tokens → Read permission to the token"
          : "add the User → API Tokens → Read permission to the token",
      ),
    );
  } else {
    const policies = token.body.result.policies;
    const ids = {
      account: io.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      zone: io.env.CLOUDFLARE_ZONE_ID ?? "",
    };
    const checkable = requiredPermissions(context).filter(
      (permission) => ids.account || zoneScoped.has(permission),
    );
    accessGranted = accessPermissions.every((permission) =>
      granted(policies, permission, ids),
    );
    for (const permission of checkable) {
      findings.push(
        granted(policies, permission, ids)
          ? ok("cloudflare", `CLOUDFLARE_API_TOKEN has ${permission}`)
          : fail(
              "cloudflare",
              `CLOUDFLARE_API_TOKEN lacks ${permission}${zoneScoped.has(permission) ? ` on ${zoneName ?? config.domain}` : ""}`,
              `edit the token in Cloudflare → ${tokenPage} and add ${permission}${zoneScoped.has(permission) ? ` for zone ${zoneName ?? config.domain}` : " for this account"}`,
            ),
      );
    }
  }

  // Without these permissions the probe fails anyway, and blaming Zero Trust would mislead.
  if (
    io.env.CLOUDFLARE_ACCOUNT_ID &&
    accessFor(config, context.environment) &&
    accessGranted
  ) {
    const apps = await get<unknown[]>(
      context,
      `/accounts/${io.env.CLOUDFLARE_ACCOUNT_ID}/access/apps`,
    );
    findings.push(
      apps.body?.success
        ? ok(
            "cloudflare",
            `Zero Trust is enabled, so Access can keep ${context.environment} private`,
          )
        : fail(
            "cloudflare",
            `${context.environment} is private, but Cloudflare Access is not available on the account (HTTP ${apps.status})`,
            `open ${zeroTrustPage}, choose a team name and the Free plan (it asks for payment details but does not charge), then run check again`,
          ),
    );
  }

  if (
    io.env.CLOUDFLARE_ACCOUNT_ID &&
    Object.values(config.services).some(
      (service) => service.target === "cloudflare-container",
    )
  ) {
    const subscriptions = await get<Subscription[]>(
      context,
      `/accounts/${io.env.CLOUDFLARE_ACCOUNT_ID}/subscriptions`,
    );
    if (!subscriptions.body?.success) {
      findings.push(
        warn(
          "cloudflare",
          "cannot read the account's subscriptions to confirm the Workers Paid plan",
          "add Account → Billing → Read to the token so check can confirm Workers Paid, which Containers need",
        ),
      );
    } else {
      findings.push(
        onWorkersPaid(subscriptions.body.result)
          ? ok(
              "cloudflare",
              "the account is on Workers Paid, which Containers need",
            )
          : fail(
              "cloudflare",
              "the account is not on Workers Paid, and Cloudflare Containers need it",
              "subscribe to Workers Paid in Workers & Pages → Plans",
            ),
      );
    }
  }
  return findings;
};
