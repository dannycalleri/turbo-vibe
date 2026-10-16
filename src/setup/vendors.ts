import type { Config } from "../config/schema.js";
import { Cancelled, type Io } from "../io.js";
import { type Checked, checked } from "./checked.js";

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

export async function choose<T>(
  items: readonly T[],
  label: (item: T) => string,
  what: string,
  io: Io,
): Promise<T | undefined> {
  if (items.length <= 1) return items[0];
  if (io.prompts) {
    const index = await io.prompts.select(
      what,
      items.map((item, index) => ({
        value: String(index),
        label: label(item),
      })),
    );
    if (index === undefined) throw new Cancelled();
    return items[Number(index)];
  }
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

const names = (items: readonly { name: string }[]) =>
  items.map((item) => item.name).join(", ");

export async function supabaseSecrets(
  config: Config,
  askSecret: (question: string) => Promise<string>,
  io: Io,
): Promise<Record<string, string>> {
  for (;;) {
    const token = (await askSecret("Supabase access token")).trim();
    if (!token) return {};
    const result = await checked(
      io,
      "checking the Supabase token",
      async () => {
        const listed = await getJson<{ id: string; name: string }[]>(
          "https://api.supabase.com/v1/organizations",
          token,
          io,
        );
        if (listed.status !== 200 || !listed.body)
          return {
            problem: `Supabase refuses the token (HTTP ${listed.status}); create a new one with the steps above and paste it`,
          };
        if (listed.body.length === 0)
          return {
            problem:
              "the Supabase token sees no organization; create one at https://supabase.com/dashboard/new, then paste the token again",
          };
        return {
          value: listed.body,
          found: `the Supabase token works and sees ${listed.body.length === 1 ? "the organization" : "the organizations"} ${names(listed.body)}`,
        };
      },
    );
    if (!("value" in result)) continue;
    const values: Record<string, string> = { SUPABASE_ACCESS_TOKEN: token };
    if (
      !Object.values(config.services).some(
        (service) => service.kind === "database" && !service.organization,
      )
    )
      return values;
    const organization = await choose(
      result.value,
      (item) => `${item.name} (${item.id})`,
      "Supabase organization",
      io,
    );
    if (!organization) return values;
    io.stdout(`supabase: organization ${organization.name}\n`);
    return { ...values, SUPABASE_ORGANIZATION: organization.id };
  }
}

export async function vercelSecrets(
  askSecret: (question: string) => Promise<string>,
  io: Io,
): Promise<Record<string, string>> {
  for (;;) {
    const token = (await askSecret("Vercel access token")).trim();
    if (!token) return {};
    const result = await checked(io, "checking the Vercel token", async () => {
      const listed = await getJson<{ teams?: { id: string; name: string }[] }>(
        "https://api.vercel.com/v2/teams",
        token,
        io,
      );
      if (listed.status !== 200)
        return {
          problem: `Vercel refuses the token (HTTP ${listed.status}); create a new one with the steps above and paste it`,
        };
      const teams = listed.body?.teams ?? [];
      if (teams.length === 0)
        return {
          problem:
            "the Vercel token sees no team; create it with the team as its scope, then paste it again",
        };
      return {
        value: teams,
        found: `the Vercel token works and sees ${teams.length === 1 ? "the team" : "the teams"} ${names(teams)}`,
      };
    });
    if (!("value" in result)) continue;
    const team = await choose(
      result.value,
      (item) => `${item.name} (${item.id})`,
      "Vercel team",
      io,
    );
    if (!team) return { VERCEL_API_TOKEN: token };
    io.stdout(`vercel: team ${team.name}\n`);
    return { VERCEL_API_TOKEN: token, VERCEL_TEAM_ID: team.id };
  }
}

export async function workosKeyCheck(
  key: string,
  io: Io,
): Promise<Checked<string>> {
  return checked(io, "checking the WorkOS key", async () => {
    const probe = await io.fetch(
      "https://api.workos.com/user_management/redirect_uris?limit=1",
      { headers: { authorization: `Bearer ${key}` } },
    );
    return probe.ok
      ? { value: key, found: "the WorkOS key works" }
      : {
          problem: `WorkOS refuses the key (HTTP ${probe.status}); copy it again with the steps above`,
        };
  });
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
