import type { Config } from "../config/schema.js";
import type { Io } from "../io.js";

async function getJson<T>(
  url: string,
  token: string,
  io: Io,
): Promise<{ status: number; body?: T }> {
  const response = await io.fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => undefined)) as T | undefined;
  return { status: response.status, ...(body === undefined ? {} : { body }) };
}

async function choose<T>(
  items: readonly T[],
  label: (item: T) => string,
  what: string,
  io: Io,
): Promise<T | undefined> {
  if (items.length <= 1) return items[0];
  io.stdout(
    `${items.map((item, index) => `  ${index + 1}. ${label(item)}`).join("\n")}\n`,
  );
  for (;;) {
    const answer = (
      (await io.ask?.(`${what} [1-${items.length}]`)) ?? ""
    ).trim();
    if (!answer) return undefined;
    const chosen = items[Number(answer) - 1];
    if (chosen) return chosen;
    io.stdout(`choose a number from 1 to ${items.length}\n`);
  }
}

export async function supabaseSecrets(
  config: Config,
  askSecret: (question: string) => Promise<string>,
  io: Io,
): Promise<Record<string, string> | undefined> {
  const token = (
    await askSecret("Supabase access token (Account → Access Tokens)")
  ).trim();
  if (!token) return {};
  const values: Record<string, string> = { SUPABASE_ACCESS_TOKEN: token };
  if (
    !Object.values(config.services).some(
      (service) => service.kind === "database" && !service.organization,
    )
  )
    return values;
  const listed = await getJson<{ id: string; name: string }[]>(
    "https://api.supabase.com/v1/organizations",
    token,
    io,
  );
  if (listed.status !== 200 || !listed.body) {
    io.stderr(
      `Supabase rejects the access token (HTTP ${listed.status}); create a new one in Account → Access Tokens\n`,
    );
    return undefined;
  }
  if (listed.body.length === 0) {
    io.stderr(
      "the Supabase access token sees no organization; create one in the Supabase dashboard, then run setup again\n",
    );
    return undefined;
  }
  const organization = await choose(
    listed.body,
    (item) => `${item.name} (${item.id})`,
    "Supabase organization",
    io,
  );
  if (!organization) return values;
  io.stdout(`supabase: organization ${organization.name}\n`);
  return { ...values, SUPABASE_ORGANIZATION: organization.id };
}

export async function vercelSecrets(
  askSecret: (question: string) => Promise<string>,
  io: Io,
): Promise<Record<string, string> | undefined> {
  const token = (
    await askSecret("Vercel access token (Account Settings → Tokens)")
  ).trim();
  if (!token) return {};
  const listed = await getJson<{ teams?: { id: string; name: string }[] }>(
    "https://api.vercel.com/v2/teams",
    token,
    io,
  );
  if (listed.status !== 200) {
    io.stderr(
      `Vercel rejects the access token (HTTP ${listed.status}); create a new one in Account Settings → Tokens\n`,
    );
    return undefined;
  }
  const teams = listed.body?.teams ?? [];
  if (teams.length === 0) {
    io.stderr(
      "the Vercel token sees no team; create the token in the team's scope, then run setup again\n",
    );
    return undefined;
  }
  const team = await choose(
    teams,
    (item) => `${item.name} (${item.id})`,
    "Vercel team",
    io,
  );
  if (!team) return { VERCEL_API_TOKEN: token };
  io.stdout(`vercel: team ${team.name}\n`);
  return { VERCEL_API_TOKEN: token, VERCEL_TEAM_ID: team.id };
}

export function workosKeyProblem(
  environment: string,
  key: string,
): string | undefined {
  const production = environment === "production";
  const prefix = production ? "sk_live_" : "sk_test_";
  return key.startsWith(prefix)
    ? undefined
    : `${environment} needs the WorkOS ${production ? "production" : "staging"} environment's key, which starts with ${prefix}`;
}
