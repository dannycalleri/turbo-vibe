import { deploySecrets } from "../deploy.js";
import { requiredSecrets } from "../infrastructure.js";
import type { Check, CheckContext, Finding } from "./types.js";
import { fail, missing, ok, warn } from "./types.js";

async function getJson<T>(
  { io }: CheckContext,
  url: string,
  token: string | undefined,
): Promise<{ status: number; body?: T }> {
  const response = await io.fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => undefined)) as T | undefined;
  return { status: response.status, ...(body === undefined ? {} : { body }) };
}

export const supabase: Check = async (context) => {
  const { config, environment, io } = context;
  const entry = Object.entries(config.services).find(
    ([, service]) => service.kind === "database",
  );
  if (entry?.[1].kind !== "database") return [];
  const [name, service] = entry;
  const token = io.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    return [
      missing(
        "supabase",
        "SUPABASE_ACCESS_TOKEN",
        "create a personal access token in Supabase → Account → Access Tokens",
      ),
    ];
  }
  const api = "https://api.supabase.com/v1";
  const organization = await getJson<{ plan?: string }>(
    context,
    `${api}/organizations/${service.organization}`,
    token,
  );
  if (organization.status === 401) {
    return [
      fail(
        "supabase",
        "SUPABASE_ACCESS_TOKEN is not valid",
        "create a new personal access token in Supabase → Account → Access Tokens",
      ),
    ];
  }
  if (!organization.body?.plan) {
    return [
      fail(
        "supabase",
        `SUPABASE_ACCESS_TOKEN cannot see organization ${service.organization}`,
        `check \`organization\` is the slug in Organization Settings, and that the token's user is a member of it`,
      ),
    ];
  }
  const findings: Finding[] = [];
  const plan = organization.body.plan;
  const paid = plan !== "free";
  if (!paid && (service.plan === "paid" || service.staging === "branch")) {
    findings.push(
      fail(
        "supabase",
        `organization ${service.organization} is on the free plan, but the config says plan: paid${service.staging === "branch" ? " and staging: branch" : ""}`,
        "upgrade the organization to Pro, or set plan: free and staging: project",
      ),
    );
  } else {
    findings.push(
      ok(
        "supabase",
        `organization ${service.organization} is on the ${plan} plan`,
      ),
    );
  }

  const projects = await getJson<
    { id: string; name: string; organization_id: string; status: string }[]
  >(context, `${api}/projects`, token);
  if (projects.status !== 200 || !Array.isArray(projects.body)) {
    findings.push(
      warn(
        "supabase",
        `cannot list projects to check for paused ones or the free plan's limit (HTTP ${projects.status})`,
        "rerun check; if it keeps failing, check the token in Supabase → Account → Access Tokens",
      ),
    );
    return findings;
  }
  const inOrganization = projects.body.filter(
    (project) => project.organization_id === service.organization,
  );
  const own = inOrganization.find(
    (project) => project.name === `${config.project}-${name}-${environment}`,
  );
  const paused = new Set(["INACTIVE", "PAUSING", "PAUSE_FAILED"]);
  if (own && paused.has(own.status)) {
    findings.push(
      fail(
        "supabase",
        `project ${own.name} is paused`,
        `restore it in the Supabase dashboard (project ${own.id}); free projects pause after a week without activity`,
      ),
    );
  }
  const active = inOrganization.filter(
    (project) => !paused.has(project.status),
  );
  if (
    !paid &&
    !own &&
    !(environment === "staging" && service.staging === "branch") &&
    active.length >= 2
  ) {
    findings.push(
      fail(
        "supabase",
        `organization ${service.organization} already has ${active.length} active projects, and the free plan allows two`,
        "pause or delete a project you no longer need, or upgrade to Pro",
      ),
    );
  }
  return findings;
};

export const workos: Check = async (context) => {
  const { config, environment, io } = context;
  if (
    !Object.values(config.services).some(
      (service) => service.kind === "identity",
    )
  )
    return [];
  const findings: Finding[] = [];
  for (const variable of ["WORKOS_API_KEY", "WORKOS_CLIENT_ID"]) {
    if (!io.env[variable]) {
      findings.push(
        missing(
          "workos",
          variable,
          `copy the WorkOS ${environment} environment's ${variable === "WORKOS_API_KEY" ? "API key" : "client ID"} from API Keys in the WorkOS dashboard`,
        ),
      );
    }
  }
  if (findings.length > 0) return findings;
  const key = io.env.WORKOS_API_KEY ?? "";
  const expected = environment === "production" ? "sk_live_" : "sk_test_";
  if (!key.startsWith(expected)) {
    findings.push(
      fail(
        "workos",
        `WORKOS_API_KEY is not a ${environment === "production" ? "production" : "staging"} key (it should start with ${expected})`,
        `set WORKOS_API_KEY on the ${environment} GitHub environment to the WorkOS ${environment === "production" ? "production" : "staging"} environment's key`,
      ),
    );
  }
  const probe = await getJson<unknown>(
    context,
    "https://api.workos.com/user_management/redirect_uris?limit=1",
    key,
  );
  findings.push(
    probe.status === 200
      ? ok("workos", "WORKOS_API_KEY is valid")
      : fail(
          "workos",
          `WorkOS rejects WORKOS_API_KEY (HTTP ${probe.status})`,
          "create a new API key in the WorkOS dashboard; production keys are shown only once",
        ),
  );
  return findings;
};

export const vercel: Check = async (context) => {
  const { config, io } = context;
  if (
    !Object.values(config.services).some((service) =>
      service.target.startsWith("vercel-"),
    )
  )
    return [];
  const findings: Finding[] = [];
  for (const variable of ["VERCEL_API_TOKEN", "VERCEL_TEAM_ID"]) {
    if (!io.env[variable]) {
      findings.push(
        missing(
          "vercel",
          variable,
          "create an access token in Vercel → Account Settings → Tokens, and copy the team ID from Team Settings",
        ),
      );
    }
  }
  if (findings.length > 0) return findings;
  const team = await getJson<{ billing?: { plan?: string } }>(
    context,
    `https://api.vercel.com/v2/teams/${io.env.VERCEL_TEAM_ID}`,
    io.env.VERCEL_API_TOKEN,
  );
  if (team.status !== 200) {
    return [
      fail(
        "vercel",
        `VERCEL_API_TOKEN cannot read team VERCEL_TEAM_ID (HTTP ${team.status})`,
        "check the token is valid and scoped to that team, and that VERCEL_TEAM_ID is the team's ID",
      ),
    ];
  }
  const plan = team.body?.billing?.plan;
  if (!plan) {
    return [
      warn(
        "vercel",
        "could not read the team's plan",
        "confirm the plan in Vercel → Team Settings → Billing; Hobby forbids commercial use",
      ),
    ];
  }
  return [
    plan === "hobby"
      ? warn(
          "vercel",
          "the team is on Hobby, which forbids commercial use",
          "upgrade to Pro ($20 per user per month) for a commercial project",
        )
      : ok("vercel", `the team is on the ${plan} plan`),
  ];
};

export const github: Check = async (context) => {
  const { config, environment, io } = context;
  const repository = io.env.GITHUB_REPOSITORY;
  if (!io.env.GITHUB_TOKEN || !repository) {
    return [
      warn(
        "github",
        "GitHub environments not checked: GITHUB_TOKEN and GITHUB_REPOSITORY are not both set",
        "set GITHUB_TOKEN (a token that can read the repository's environments) and GITHUB_REPOSITORY (owner/name) to check them",
      ),
    ];
  }
  const api = `https://api.github.com/repos/${repository}/environments/${environment}`;
  const settings = await getJson<{ protection_rules?: { type: string }[] }>(
    context,
    api,
    io.env.GITHUB_TOKEN,
  );
  if (settings.status === 404) {
    return [
      fail(
        "github",
        `${repository} has no ${environment} environment`,
        `create it in Settings → Environments → New environment`,
      ),
    ];
  }
  if (settings.status !== 200) {
    return [
      warn(
        "github",
        `cannot read the ${environment} environment (HTTP ${settings.status})`,
        "use a GITHUB_TOKEN that can read the repository's environments",
      ),
    ];
  }
  const findings: Finding[] = [];
  if (environment === "production") {
    const reviewed = (settings.body?.protection_rules ?? []).some(
      (rule) => rule.type === "required_reviewers",
    );
    findings.push(
      reviewed
        ? ok("github", "production requires a reviewer's approval")
        : fail(
            "github",
            "production has no required reviewers, so promotion would not wait for approval",
            "add required reviewers in Settings → Environments → production",
          ),
    );
  }
  const secrets = await getJson<{ secrets?: { name: string }[] }>(
    context,
    `${api}/secrets?per_page=100`,
    io.env.GITHUB_TOKEN,
  );
  if (!secrets.body?.secrets) {
    findings.push(
      warn(
        "github",
        `cannot list the ${environment} environment's secrets (HTTP ${secrets.status})`,
        "use a token with read access to environment secrets",
      ),
    );
    return findings;
  }
  const present = new Set(secrets.body.secrets.map((secret) => secret.name));
  const needed = [
    ...new Set([...requiredSecrets(config), ...deploySecrets(config)]),
  ].sort();
  const absent = needed.filter((name) => !present.has(name));
  findings.push(
    absent.length === 0
      ? ok(
          "github",
          `the ${environment} environment has every secret the project needs`,
        )
      : fail(
          "github",
          `the ${environment} environment is missing ${absent.join(", ")}`,
          `add them in Settings → Environments → ${environment} → Environment secrets`,
        ),
  );
  return findings;
};
