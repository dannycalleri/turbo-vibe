import { createHash } from "node:crypto";
import {
  granted,
  onWorkersPaid,
  requiredPermissions,
  type Subscription,
  zoneScoped,
} from "../checks/cloudflare.js";
import type { Config } from "../config/schema.js";
import type { Io } from "../io.js";
import { choose } from "./vendors.js";

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
  "TURBO_VIBE_BUILDS_BUCKET",
  "CLOUDFLARE_API_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

export interface Provided {
  values: Record<string, string>;
  replace: string[];
}

const r2Permission = "Workers R2 Storage Bucket Item Write";
const r2ReadPermission = "Workers R2 Storage Bucket Item Read";

// check reads the token's own policies and the account's plan, so the CI token can read both.
function ciPermissions(config: Config, environment: string): string[] {
  return [
    ...requiredPermissions({ config, environment }),
    "Account API Tokens Read",
    ...(hasContainer(config) ? ["Billing Read"] : []),
  ];
}

export function stateBucketName(config: Config, environment: string): string {
  return `turbo-vibe-${config.project}-${environment}`;
}

export function earlierStateBucketName(
  config: Config,
  environment: string,
): string {
  return `${config.project}-turbo-vibe-${environment}`;
}

function bucketResource(account: string, bucket: string): string {
  return `com.cloudflare.edge.r2.bucket.${account}_default_${bucket}`;
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
      "the bootstrap token is not an active token of this account; create one with the steps above and paste it\n",
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
      "the bootstrap token lacks Account API Tokens Write, so it cannot create the CI tokens; create one with the steps above and paste it\n",
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
  scopes?: string[];
}

const zoneScope = "com.cloudflare.api.account.zone";

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
  // One name can belong to an account group and a zone group, such as Access: Apps and Policies Write.
  const ids = new Map<string, string>();
  for (const group of listed.body?.result ?? []) {
    const onZone = group.scopes?.includes(zoneScope) ?? false;
    if (!ids.has(group.name) || onZone === zoneScoped.has(group.name))
      ids.set(group.name, group.id);
  }
  const unknown = names.filter((name) => !ids.has(name));
  if (unknown.length > 0) {
    io.stderr(
      `Cloudflare has no permission group named ${unknown.join(", ")}; nothing was created\n`,
    );
    return undefined;
  }
  return ids;
}

async function tokensNamed(
  cloudflare: CloudflareApi,
  account: string,
  name: string,
): Promise<string[]> {
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
  return matching;
}

async function deleteTokensNamed(
  cloudflare: CloudflareApi,
  account: string,
  name: string,
): Promise<void> {
  for (const id of await tokensNamed(cloudflare, account, name))
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

function hasContainer(config: Config): boolean {
  return Object.values(config.services).some(
    (service) => service.target === "cloudflare-container",
  );
}

function setupPermissions(config: Config): string[] {
  return [
    "Zone Write",
    "Workers R2 Storage Write",
    ...(hasContainer(config) ? ["Billing Read"] : []),
  ];
}

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
          permission_groups: setupPermissions(config)
            .filter((permission) => permission !== "Zone Write")
            .map((permission) => ({ id: groups.get(permission) })),
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

async function waitForPerson(
  instruction: string,
  url: string,
  io: Io,
): Promise<boolean> {
  io.stdout(`cloudflare: ${instruction}: ${url}\n`);
  const answer = (
    (await io.ask?.("Press Enter when done, or type q to stop")) ?? ""
  )
    .trim()
    .toLowerCase();
  return answer !== "q";
}

async function bucket(
  cloudflare: CloudflareApi,
  config: Config,
  environment: string,
  account: string,
  io: Io,
): Promise<string | undefined> {
  const path = `/accounts/${account}/r2/buckets`;
  const name = stateBucketName(config, environment);
  for (;;) {
    // A bucket under the earlier name holds the environment's state, so it wins over a new-named one.
    for (const existing of [
      earlierStateBucketName(config, environment),
      name,
    ]) {
      const found = await cloudflare.call("GET", `${path}/${existing}`);
      if (found.body?.success) {
        io.stdout(`cloudflare: bucket ${existing} exists\n`);
        return existing;
      }
    }
    const created = await cloudflare.call("POST", path, { name });
    if (created.body?.success) {
      io.stdout(`cloudflare: bucket ${name} created\n`);
      return name;
    }
    if (!created.body?.errors?.some((error) => error.code === 10042)) {
      io.stderr(
        `cannot create bucket ${name}: ${created.body?.errors?.map((error) => error.message).join("; ") ?? `HTTP ${created.status}`}\n`,
      );
      return undefined;
    }
    if (
      !(await waitForPerson(
        "R2 is not enabled on this account; enable it in R2 Object Storage",
        `https://dash.cloudflare.com/${account}/r2/overview`,
        io,
      ))
    ) {
      io.stderr("stopped: R2 is not enabled, so there is no state bucket\n");
      return undefined;
    }
  }
}

async function workersPaid(
  cloudflare: CloudflareApi,
  account: string,
  io: Io,
): Promise<boolean> {
  for (;;) {
    const subscriptions = await cloudflare.call<Subscription[]>(
      "GET",
      `/accounts/${account}/subscriptions`,
    );
    if (!subscriptions.body?.success) {
      io.stdout(
        "cloudflare: cannot read the account's plan; check confirms Workers Paid at the end\n",
      );
      return true;
    }
    if (onWorkersPaid(subscriptions.body.result)) {
      io.stdout("cloudflare: the account is on Workers Paid\n");
      return true;
    }
    if (
      !(await waitForPerson(
        "Containers need the Workers Paid plan; subscribe in Workers & Pages → Plans",
        `https://dash.cloudflare.com/${account}/workers/plans`,
        io,
      ))
    ) {
      io.stderr("stopped: the account is not on Workers Paid\n");
      return false;
    }
  }
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
  environment: string,
  account: string,
  zoneId: string,
  groups: ReadonlyMap<string, string>,
): unknown[] {
  return policiesFor(
    ciPermissions(config, environment),
    account,
    zoneId,
    groups,
  );
}

function policiesFor(
  names: readonly string[],
  account: string,
  zoneId: string,
  groups: ReadonlyMap<string, string>,
): unknown[] {
  const ids = (scoped: boolean) =>
    names
      .filter((name) => zoneScoped.has(name) === scoped)
      .map((name) => ({ id: groups.get(name) }));
  const zone = ids(true);
  const onAccount = ids(false);
  return [
    ...(onAccount.length > 0
      ? [
          {
            effect: "allow",
            resources: { [`com.cloudflare.api.account.${account}`]: "*" },
            permission_groups: onAccount,
          },
        ]
      : []),
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

interface ReadToken {
  name: string;
  status?: string;
  condition?: unknown;
  expires_on?: string;
  not_before?: string;
  policies?: {
    effect?: string;
    resources?: Record<string, unknown>;
    permission_groups?: { id?: string; name: string }[];
  }[];
}

function zoneOf(token: ReadToken): string | undefined {
  for (const { resources = {} } of token.policies ?? [])
    for (const [key, nested] of Object.entries(resources)) {
      const keys = [
        key,
        ...(typeof nested === "object" && nested ? Object.keys(nested) : []),
      ];
      for (const candidate of keys) {
        const zone = candidate.match(
          /^com\.cloudflare\.api\.account\.zone\.(.+)$/,
        )?.[1];
        if (zone && zone !== "*") return zone;
      }
    }
  return undefined;
}

async function addMissingPermissions(
  bootstrap: CloudflareApi,
  config: Config,
  account: string,
  environment: string,
  groups: ReadonlyMap<string, string>,
  io: Io,
  knownZone?: string,
): Promise<boolean> {
  const name = `turbo-vibe-${config.project}-${environment}`;
  const replace = `run setup --replace CLOUDFLARE_API_TOKEN --env ${environment} to create it again`;
  const [id] = await tokensNamed(bootstrap, account, name);
  const read = id
    ? await bootstrap.call<ReadToken>(
        "GET",
        `/accounts/${account}/tokens/${id}`,
      )
    : undefined;
  const token = read?.body?.result;
  const zone = token && (knownZone ?? zoneOf(token));
  if (!id || !token || !zone) {
    io.stdout(
      `warn  cloudflare: cannot read the token ${name} or its zone; ${replace}\n`,
    );
    return true;
  }
  const missing = ciPermissions(config, environment).filter(
    (permission) =>
      !granted(token.policies ?? [], permission, { account, zone }),
  );
  if (missing.length === 0) {
    io.stdout(`cloudflare: token ${name} has every permission it needs\n`);
    return true;
  }
  const updated = await bootstrap.call(
    "PUT",
    `/accounts/${account}/tokens/${id}`,
    {
      name: token.name,
      ...(token.status ? { status: token.status } : {}),
      ...(token.condition ? { condition: token.condition } : {}),
      ...(token.expires_on ? { expires_on: token.expires_on } : {}),
      ...(token.not_before ? { not_before: token.not_before } : {}),
      policies: [
        ...(token.policies ?? []).map((policy) => ({
          effect: policy.effect,
          resources: policy.resources,
          permission_groups: (policy.permission_groups ?? []).map((group) => ({
            id: group.id,
          })),
        })),
        ...policiesFor(missing, account, zone, groups),
      ],
    },
  );
  if (!updated.body?.success) {
    io.stderr(
      `cannot update the Cloudflare token ${name} (HTTP ${updated.status}); ${replace}\n`,
    );
    return false;
  }
  io.stdout(`cloudflare: token ${name} now has ${missing.join(", ")}\n`);
  return true;
}

async function environmentTokens(
  bootstrap: CloudflareApi,
  config: Config,
  account: string,
  zoneId: string,
  environment: string,
  buckets: { own: string; builds?: string },
  present: ReadonlySet<string>,
  groups: ReadonlyMap<string, string>,
  io: Io,
): Promise<Provided | undefined> {
  const { own, builds } = buckets;
  const provided: Provided = {
    values: {
      CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_ZONE_ID: zoneId,
      TURBO_VIBE_STATE_BUCKET: own,
      ...(builds ? { TURBO_VIBE_BUILDS_BUCKET: builds } : {}),
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
      ciPolicies(config, environment, account, zoneId, groups),
      io,
    );
    if (!ci) return undefined;
    provided.values.CLOUDFLARE_API_TOKEN = ci.value;
  } else if (
    !(await addMissingPermissions(
      bootstrap,
      config,
      account,
      environment,
      groups,
      io,
      zoneId,
    ))
  )
    return undefined;
  if (
    !present.has("AWS_ACCESS_KEY_ID") ||
    !present.has("AWS_SECRET_ACCESS_KEY") ||
    !present.has("TURBO_VIBE_STATE_BUCKET") ||
    (builds && !present.has("TURBO_VIBE_BUILDS_BUCKET"))
  ) {
    const r2 = await createToken(
      bootstrap,
      account,
      `${name}-r2`,
      [
        {
          effect: "allow",
          resources: { [bucketResource(account, own)]: "*" },
          permission_groups: [{ id: groups.get(r2Permission) }],
        },
        ...(builds
          ? [
              {
                effect: "allow",
                resources: { [bucketResource(account, builds)]: "*" },
                permission_groups: [{ id: groups.get(r2ReadPermission) }],
              },
            ]
          : []),
      ],
      io,
    );
    if (!r2) return undefined;
    provided.values.AWS_ACCESS_KEY_ID = r2.id;
    provided.values.AWS_SECRET_ACCESS_KEY = createHash("sha256")
      .update(r2.value)
      .digest("hex");
    // The stored bucket names must name the buckets the new keys reach, even where an older name was kept.
    provided.replace.push(
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "TURBO_VIBE_STATE_BUCKET",
      ...(builds ? ["TURBO_VIBE_BUILDS_BUCKET"] : []),
    );
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

async function askBootstrapToken(
  askSecret: (question: string) => Promise<string>,
  io: Io,
): Promise<
  | {
      bootstrap: CloudflareApi;
      account: string;
      token: { id: string; name: string };
    }
  | undefined
> {
  for (;;) {
    const token = (await askSecret("Cloudflare bootstrap token")).trim();
    if (!token) {
      io.stderr(
        "setup needs a Cloudflare bootstrap token; create one with the steps above\n",
      );
      return undefined;
    }
    const bootstrap = cloudflareApi(token, io);
    const listed = await bootstrap.call<{ id: string; name: string }[]>(
      "GET",
      "/accounts",
    );
    const accounts = listed.body?.result ?? [];
    if (listed.status !== 200) {
      io.stderr(
        `Cloudflare refuses the bootstrap token (HTTP ${listed.status}); create one with the steps above and paste it\n`,
      );
      continue;
    }
    if (accounts.length === 0) {
      io.stderr(
        "the bootstrap token sees no Cloudflare account; create it under Manage Account → Account API Tokens, so the account owns it, and paste it\n",
      );
      continue;
    }
    const account = await choose(
      accounts,
      (item) => `${item.name} (${item.id})`,
      "Cloudflare account",
      io,
    );
    if (!account) return undefined;
    const accepted = await canCreateTokens(bootstrap, account.id, io);
    if (accepted) {
      io.stdout(
        `cloudflare: the bootstrap token works on the account ${account.name}\n`,
      );
      return { bootstrap, account: account.id, token: accepted };
    }
  }
}

export async function setupCloudflare(
  config: Config,
  present: ReadonlyMap<string, ReadonlySet<string>>,
  askSecret: (question: string) => Promise<string>,
  io: Io,
): Promise<
  | {
      provided: Map<string, Provided>;
      offerToDeleteBootstrap: () => Promise<void>;
    }
  | undefined
> {
  const accepted = await askBootstrapToken(askSecret, io);
  if (!accepted) return undefined;
  const { bootstrap, account, token: bootstrapToken } = accepted;
  const groups = await permissionGroups(
    bootstrap,
    account,
    [
      ...setupPermissions(config),
      ...ciPermissions(config, "staging"),
      ...ciPermissions(config, "production"),
      r2Permission,
      r2ReadPermission,
    ],
    io,
  );
  if (!groups) return undefined;
  const environments = [...present.keys()];
  const bucketEnvironments = [
    ...new Set([
      ...environments,
      // Production's token reads staging's bucket, so that bucket must exist even when only production is set up.
      ...(environments.includes("production") ? ["staging"] : []),
    ]),
  ];
  const buckets = new Map<string, string>();
  const zoneId = await withSetupToken(
    bootstrap,
    config,
    account,
    groups,
    io,
    async (cloudflare) => {
      if (hasContainer(config) && !(await workersPaid(cloudflare, account, io)))
        return undefined;
      const id = await zone(cloudflare, config, account, io);
      if (!id) return undefined;
      for (const environment of bucketEnvironments) {
        const name = await bucket(cloudflare, config, environment, account, io);
        if (!name) return undefined;
        buckets.set(environment, name);
      }
      return id;
    },
  );
  if (!zoneId) return undefined;
  const provided = new Map<string, Provided>();
  const bucketOf = (environment: string): string => {
    const name = buckets.get(environment);
    if (!name)
      throw new Error(`setup resolved no state bucket for ${environment}`);
    return name;
  };
  for (const [environment, names] of present) {
    const tokens = await environmentTokens(
      bootstrap,
      config,
      account,
      zoneId,
      environment,
      {
        own: bucketOf(environment),
        ...(environment === "production"
          ? { builds: bucketOf("staging") }
          : {}),
      },
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

export async function updateCiTokens(
  config: Config,
  environments: readonly string[],
  askSecret: (question: string) => Promise<string>,
  io: Io,
): Promise<{ offerToDeleteBootstrap: () => Promise<void> } | undefined> {
  const accepted = await askBootstrapToken(askSecret, io);
  if (!accepted) return undefined;
  const { bootstrap, account, token } = accepted;
  const groups = await permissionGroups(
    bootstrap,
    account,
    environments.flatMap((environment) => ciPermissions(config, environment)),
    io,
  );
  if (!groups) return undefined;
  for (const environment of environments)
    if (
      !(await addMissingPermissions(
        bootstrap,
        config,
        account,
        environment,
        groups,
        io,
      ))
    )
      return undefined;
  return {
    offerToDeleteBootstrap: () => offerToDelete(bootstrap, account, token, io),
  };
}
