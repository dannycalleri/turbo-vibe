import { createHash } from "node:crypto";
import {
  granted,
  requiredPermissions,
  zoneScoped,
} from "../checks/cloudflare.js";
import type { Config, EnvironmentName } from "../config/schema.js";
import type { Io } from "../io.js";

const api = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
}

interface CloudflareApi {
  call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body?: Envelope<T> }>;
}

function cloudflareApi(token: string, io: Io): CloudflareApi {
  return {
    async call<T>(method: string, path: string, body?: unknown) {
      const response = await io.fetch(`${api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const parsed = (await response.json().catch(() => undefined)) as
        | Envelope<T>
        | undefined;
      return { status: response.status, ...(parsed ? { body: parsed } : {}) };
    },
  };
}

export const cloudflareSecrets = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "TURBO_VIBE_STATE_BUCKET",
  "CLOUDFLARE_API_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

export interface Provided {
  values: Record<string, string>;
  replace: string[];
}

const r2Permission = "Workers R2 Storage Bucket Item Write";

// check reads the token's own policies and the account's plan, so the CI token can read both.
function ciPermissions(config: Config): string[] {
  const container = Object.values(config.services).some(
    (service) => service.target === "cloudflare-container",
  );
  return [
    ...requiredPermissions({ config }),
    "Account API Tokens Read",
    ...(container ? ["Billing Read"] : []),
  ];
}

function stateBucketName(config: Config): string {
  return `${config.project}-turbo-vibe-state`;
}

function zoneCandidates(domain: string): string[] {
  const labels = domain.split(".");
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
}

// The same rule init uses: a two-label domain is the apex, a longer one sits one level below it.
function zoneGuess(domain: string): string {
  const labels = domain.split(".");
  return labels.length <= 2 ? domain : labels.slice(1).join(".");
}

async function canCreateTokens(
  cloudflare: CloudflareApi,
  account: string,
  io: Io,
): Promise<{ id: string; name: string } | undefined> {
  const tokens = `/accounts/${account}/tokens`;
  const verified = await cloudflare.call<{ id: string; status: string }>(
    "GET",
    `${tokens}/verify`,
  );
  if (verified.body?.result?.status !== "active") {
    io.stderr(
      "the bootstrap token is not an active token of this account; create it in Cloudflare → Manage Account → Account API Tokens\n",
    );
    return undefined;
  }
  const own = await cloudflare.call<{
    name?: string;
    policies?: Parameters<typeof granted>[0];
  }>("GET", `${tokens}/${verified.body.result.id}`);
  const policies = own.body?.result?.policies;
  if (
    !policies ||
    !granted(policies, "Account API Tokens Write", { account, zone: "" })
  ) {
    io.stderr(
      "the bootstrap token lacks Account API Tokens Write, so it cannot create the CI tokens; add that permission and run setup again\n",
    );
    return undefined;
  }
  return {
    id: verified.body.result.id,
    name: own.body?.result?.name ?? verified.body.result.id,
  };
}

interface PermissionGroup {
  id: string;
  name: string;
}

async function permissionGroups(
  cloudflare: CloudflareApi,
  account: string,
  names: readonly string[],
  io: Io,
): Promise<Map<string, string> | undefined> {
  const listed = await cloudflare.call<PermissionGroup[]>(
    "GET",
    `/accounts/${account}/tokens/permission_groups`,
  );
  const ids = new Map(
    (listed.body?.result ?? []).map((group) => [group.name, group.id]),
  );
  const unknown = names.filter((name) => !ids.has(name));
  if (unknown.length > 0) {
    io.stderr(
      `Cloudflare has no permission group named ${unknown.join(", ")}; nothing was created\n`,
    );
    return undefined;
  }
  return ids;
}

async function deleteTokensNamed(
  cloudflare: CloudflareApi,
  account: string,
  name: string,
): Promise<void> {
  const matching: string[] = [];
  for (let page = 1; ; page++) {
    const listed = await cloudflare.call<{ id: string; name: string }[]>(
      "GET",
      `/accounts/${account}/tokens?per_page=50&page=${page}`,
    );
    const tokens = listed.body?.result ?? [];
    for (const token of tokens)
      if (token.name === name) matching.push(token.id);
    if (tokens.length < 50) break;
  }
  for (const id of matching)
    await cloudflare.call("DELETE", `/accounts/${account}/tokens/${id}`);
}

async function untilActive(
  cloudflare: CloudflareApi,
  account: string,
  io: Io,
): Promise<boolean> {
  for (let waited = 0; waited <= 30_000; waited += 2_000) {
    const verified = await cloudflare.call<{ status: string }>(
      "GET",
      `/accounts/${account}/tokens/verify`,
    );
    if (verified.body?.result?.status === "active") return true;
    await io.sleep(2_000);
  }
  return false;
}

const setupPermissions = ["Zone Write", "Workers R2 Storage Write"];

// The bootstrap token may only create tokens, so a short-lived token does the zone and bucket work.
async function withSetupToken<T>(
  bootstrap: CloudflareApi,
  config: Config,
  account: string,
  groups: ReadonlyMap<string, string>,
  io: Io,
  work: (cloudflare: CloudflareApi) => Promise<T | undefined>,
): Promise<T | undefined> {
  const name = `turbo-vibe-${config.project}-setup`;
  await deleteTokensNamed(bootstrap, account, name);
  const accountKey = `com.cloudflare.api.account.${account}`;
  const created = await bootstrap.call<{ id: string; value: string }>(
    "POST",
    `/accounts/${account}/tokens`,
    {
      name,
      expires_on: new Date(Date.now() + 60 * 60_000)
        .toISOString()
        .replace(/\.\d+Z$/, "Z"),
      policies: [
        {
          effect: "allow",
          resources: {
            [accountKey]: { "com.cloudflare.api.account.zone.*": "*" },
          },
          permission_groups: [{ id: groups.get("Zone Write") }],
        },
        {
          effect: "allow",
          resources: { [accountKey]: "*" },
          permission_groups: [{ id: groups.get("Workers R2 Storage Write") }],
        },
      ],
    },
  );
  const setup = created.body?.result;
  if (!setup) {
    io.stderr(`cannot create the setup token (HTTP ${created.status})\n`);
    return undefined;
  }
  try {
    const cloudflare = cloudflareApi(setup.value, io);
    if (!(await untilActive(cloudflare, account, io))) {
      io.stderr(
        "the setup token did not become active within 30 seconds; run setup again\n",
      );
      return undefined;
    }
    return await work(cloudflare);
  } finally {
    await bootstrap.call("DELETE", `/accounts/${account}/tokens/${setup.id}`);
  }
}

interface Zone {
  id: string;
  name: string;
  status: string;
  name_servers?: string[];
}

function nameservers(zone: Zone, io: Io): void {
  if (zone.status !== "active")
    io.stdout(
      `cloudflare: at your registrar, set the nameservers of ${zone.name} to ${(zone.name_servers ?? []).join(" and ")}; until then check reports the zone as pending\n`,
    );
}

async function zone(
  cloudflare: CloudflareApi,
  config: Config,
  account: string,
  io: Io,
): Promise<string | undefined> {
  for (const name of zoneCandidates(config.domain)) {
    const found = await cloudflare.call<Zone[]>(
      "GET",
      `/zones?name=${encodeURIComponent(name)}&account.id=${account}`,
    );
    const existing = found.body?.result?.[0];
    if (existing) {
      io.stdout(
        `cloudflare: zone ${existing.name} exists (${existing.status})\n`,
      );
      nameservers(existing, io);
      return existing.id;
    }
  }
  const guess = zoneGuess(config.domain);
  const answer = (
    (await io.ask?.(
      `Cloudflare zone to create for ${config.domain}, the domain you registered [${guess}]`,
    )) ?? ""
  ).trim();
  const name = answer || guess;
  const created = await cloudflare.call<Zone>("POST", "/zones", {
    name,
    account: { id: account },
    type: "full",
  });
  if (!created.body?.success) {
    io.stderr(
      `cannot create zone ${name}: ${created.body?.errors?.map((error) => error.message).join("; ") ?? `HTTP ${created.status}`}\n`,
    );
    return undefined;
  }
  const result = created.body.result;
  io.stdout(`cloudflare: zone ${result.name} created\n`);
  nameservers(result, io);
  return result.id;
}

async function bucket(
  cloudflare: CloudflareApi,
  name: string,
  account: string,
  io: Io,
): Promise<boolean> {
  const path = `/accounts/${account}/r2/buckets`;
  const found = await cloudflare.call("GET", `${path}/${name}`);
  if (found.body?.success) {
    io.stdout(`cloudflare: bucket ${name} exists\n`);
    return true;
  }
  const created = await cloudflare.call("POST", path, { name });
  if (created.body?.success) {
    io.stdout(`cloudflare: bucket ${name} created\n`);
    return true;
  }
  io.stderr(
    created.body?.errors?.some((error) => error.code === 10042)
      ? `R2 is not enabled on this account; enable it in Cloudflare → R2 Object Storage, then run setup again\n`
      : `cannot create bucket ${name}: ${created.body?.errors?.map((error) => error.message).join("; ") ?? `HTTP ${created.status}`}\n`,
  );
  return false;
}

async function createToken(
  bootstrap: CloudflareApi,
  account: string,
  name: string,
  policies: unknown[],
  io: Io,
): Promise<{ id: string; value: string } | undefined> {
  await deleteTokensNamed(bootstrap, account, name);
  const created = await bootstrap.call<{ id: string; value: string }>(
    "POST",
    `/accounts/${account}/tokens`,
    { name, policies },
  );
  if (!created.body?.result?.value) {
    io.stderr(
      `cannot create the Cloudflare token ${name} (HTTP ${created.status})\n`,
    );
    return undefined;
  }
  io.stdout(`cloudflare: token ${name} created\n`);
  return created.body.result;
}

function ciPolicies(
  config: Config,
  account: string,
  zoneId: string,
  groups: ReadonlyMap<string, string>,
): unknown[] {
  const names = ciPermissions(config);
  const ids = (scoped: boolean) =>
    names
      .filter((name) => zoneScoped.has(name) === scoped)
      .map((name) => ({ id: groups.get(name) }));
  const zone = ids(true);
  return [
    {
      effect: "allow",
      resources: { [`com.cloudflare.api.account.${account}`]: "*" },
      permission_groups: ids(false),
    },
    ...(zone.length > 0
      ? [
          {
            effect: "allow",
            resources: { [`com.cloudflare.api.account.zone.${zoneId}`]: "*" },
            permission_groups: zone,
          },
        ]
      : []),
  ];
}

async function environmentTokens(
  bootstrap: CloudflareApi,
  config: Config,
  account: string,
  zoneId: string,
  bucketName: string,
  environment: EnvironmentName,
  present: ReadonlySet<string>,
  groups: ReadonlyMap<string, string>,
  io: Io,
): Promise<Provided | undefined> {
  const provided: Provided = {
    values: {
      CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_ZONE_ID: zoneId,
      TURBO_VIBE_STATE_BUCKET: bucketName,
    },
    replace: [],
  };
  const name = `turbo-vibe-${config.project}-${environment}`;
  // Cloudflare shows a token's value only once, so a token whose secret is gone is replaced.
  if (!present.has("CLOUDFLARE_API_TOKEN")) {
    const ci = await createToken(
      bootstrap,
      account,
      name,
      ciPolicies(config, account, zoneId, groups),
      io,
    );
    if (!ci) return undefined;
    provided.values.CLOUDFLARE_API_TOKEN = ci.value;
  }
  if (
    !present.has("AWS_ACCESS_KEY_ID") ||
    !present.has("AWS_SECRET_ACCESS_KEY")
  ) {
    const r2 = await createToken(
      bootstrap,
      account,
      `${name}-r2`,
      [
        {
          effect: "allow",
          resources: {
            [`com.cloudflare.edge.r2.bucket.${account}_default_${bucketName}`]:
              "*",
          },
          permission_groups: [{ id: groups.get(r2Permission) }],
        },
      ],
      io,
    );
    if (!r2) return undefined;
    provided.values.AWS_ACCESS_KEY_ID = r2.id;
    provided.values.AWS_SECRET_ACCESS_KEY = createHash("sha256")
      .update(r2.value)
      .digest("hex");
    provided.replace.push("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY");
  }
  return provided;
}

async function offerToDelete(
  bootstrap: CloudflareApi,
  account: string,
  token: { id: string; name: string },
  io: Io,
): Promise<void> {
  const answer = (
    (await io.ask?.(
      `Delete the Cloudflare bootstrap token ${token.name} now? setup does not need it again until you add an environment [y/N]`,
    )) ?? ""
  )
    .trim()
    .toLowerCase();
  if (answer === "y" || answer === "yes") {
    const deleted = await bootstrap.call(
      "DELETE",
      `/accounts/${account}/tokens/${token.id}`,
    );
    if (deleted.body?.success) {
      io.stdout(`cloudflare: bootstrap token ${token.name} deleted\n`);
      return;
    }
  }
  io.stdout(
    `cloudflare: the bootstrap token ${token.name} still exists; delete it at https://dash.cloudflare.com/${account}/api-tokens when you no longer need it\n`,
  );
}

export async function setupCloudflare(
  config: Config,
  present: ReadonlyMap<EnvironmentName, ReadonlySet<string>>,
  askSecret: (question: string) => Promise<string>,
  io: Io,
): Promise<
  | {
      provided: Map<EnvironmentName, Provided>;
      offerToDeleteBootstrap: () => Promise<void>;
    }
  | undefined
> {
  const account = ((await io.ask?.("Cloudflare account ID")) ?? "").trim();
  const token = (
    await askSecret(
      "Cloudflare bootstrap token (Manage Account → Account API Tokens, with Account API Tokens Write)",
    )
  ).trim();
  if (!account || !token) {
    io.stderr("setup needs the Cloudflare account ID and a bootstrap token\n");
    return undefined;
  }
  const bootstrap = cloudflareApi(token, io);
  const bootstrapToken = await canCreateTokens(bootstrap, account, io);
  if (!bootstrapToken) return undefined;
  const groups = await permissionGroups(
    bootstrap,
    account,
    [...setupPermissions, ...ciPermissions(config), r2Permission],
    io,
  );
  if (!groups) return undefined;
  const bucketName = stateBucketName(config);
  const zoneId = await withSetupToken(
    bootstrap,
    config,
    account,
    groups,
    io,
    async (cloudflare) => {
      const id = await zone(cloudflare, config, account, io);
      return id && (await bucket(cloudflare, bucketName, account, io))
        ? id
        : undefined;
    },
  );
  if (!zoneId) return undefined;
  const provided = new Map<EnvironmentName, Provided>();
  for (const [environment, names] of present) {
    const tokens = await environmentTokens(
      bootstrap,
      config,
      account,
      zoneId,
      bucketName,
      environment,
      names,
      groups,
      io,
    );
    if (!tokens) return undefined;
    provided.set(environment, tokens);
  }
  return {
    provided,
    offerToDeleteBootstrap: () =>
      offerToDelete(bootstrap, account, bootstrapToken, io),
  };
}
