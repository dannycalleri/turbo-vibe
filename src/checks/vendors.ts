import { accessFor } from "../config/schema.js";
import { promoteFromStaging } from "../contract.js";
import { environmentSecrets } from "../deploy.js";
import { appPublic, buildSecrets } from "../secrets.js";
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
  const slug = service.organization ?? io.env.SUPABASE_ORGANIZATION;
  if (!slug) {
    return [
      missing(
        "supabase",
        "SUPABASE_ORGANIZATION",
        "set `organization` in turbo-vibe.yaml, or SUPABASE_ORGANIZATION, to the slug in Supabase → Organization Settings",
      ),
    ];
  }
  const api = "https://api.supabase.com/v1";
  const organization = await getJson<{ plan?: string }>(
    context,
    `${api}/organizations/${slug}`,
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
        `SUPABASE_ACCESS_TOKEN cannot see organization ${slug}`,
        `check the slug (\`organization\` or SUPABASE_ORGANIZATION) matches Organization Settings, and that the token's user is a member of it`,
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
        `organization ${slug} is on the free plan, but the config says plan: paid${service.staging === "branch" ? " and staging: branch" : ""}`,
        "upgrade the organization to Pro, or set plan: free and staging: project",
      ),
    );
  } else {
    findings.push(
      ok("supabase", `organization ${slug} is on the ${plan} plan`),
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
    (project) => project.organization_id === slug,
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
        `organization ${slug} already has ${active.length} active projects, and the free plan allows two`,
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
  const { config, environment, io } = context;
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
  return [
    !plan
      ? warn(
          "vercel",
          "could not read the team's plan",
          "confirm the plan in Vercel → Team Settings → Billing; Hobby forbids commercial use",
        )
      : plan === "hobby"
        ? warn(
            "vercel",
            "the team is on Hobby, which forbids commercial use",
            "upgrade the team to Pro for a commercial project",
          )
        : ok("vercel", `the team is on the ${plan} plan`),
    ...(await teamMembers(context, accessFor(config, environment)?.emails)),
  ];
};

async function teamMembers(
  context: CheckContext,
  emails: readonly string[] | undefined,
): Promise<Finding[]> {
  if (!emails) return [];
  const { environment, io } = context;
  const members = new Set<string>();
  for (let until: number | undefined; ; ) {
    const url = new URL(
      `https://api.vercel.com/v3/teams/${io.env.VERCEL_TEAM_ID}/members`,
    );
    url.searchParams.set("limit", "100");
    if (until !== undefined) url.searchParams.set("until", String(until));
    const page = await getJson<{
      members?: { email?: string; confirmed?: boolean }[];
      pagination?: { hasNext?: boolean; next?: number | null };
    }>(context, url.toString(), io.env.VERCEL_API_TOKEN);
    if (page.status !== 200) {
      return [
        warn(
          "vercel",
          `could not read the members of the Vercel team (HTTP ${page.status}), so check cannot tell who can open ${environment}`,
          `confirm in Vercel → Team Settings → Members that each address in ${environment}'s access is a member`,
        ),
      ];
    }
    for (const member of page.body?.members ?? []) {
      // An unconfirmed member has not joined yet (an access request or an open invite), and Vercel does not let them in.
      if (member.email && member.confirmed !== false)
        members.add(member.email.toLowerCase());
    }
    const next = page.body?.pagination?.next;
    if (!page.body?.pagination?.hasNext || typeof next !== "number") break;
    if (next === until) break;
    until = next;
  }
  const outside = emails.filter((email) => !members.has(email.toLowerCase()));
  if (outside.length === 0)
    return [
      ok(
        "vercel",
        `every address in ${environment}'s access is a member of the Vercel team; every member of the team can open ${environment}`,
      ),
    ];
  return outside.map((email) =>
    fail(
      "vercel",
      `${email} is in ${environment}'s access but not a member of the Vercel team, so Vercel will not let them open ${environment}`,
      `invite ${email} in Vercel → Team Settings → Members`,
    ),
  );
}

export const github: Check = async (context) => {
  const { config, environment, io } = context;
  const githubName = context.githubEnvironment ?? environment;
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
  const api = `https://api.github.com/repos/${repository}/environments/${githubName}`;
  const settings = await getJson<{ protection_rules?: { type: string }[] }>(
    context,
    api,
    io.env.GITHUB_TOKEN,
  );
  if (settings.status === 404) {
    return [
      fail(
        "github",
        `${repository} has no ${githubName} environment`,
        `create it in Settings → Environments → New environment`,
      ),
    ];
  }
  if (settings.status !== 200) {
    return [
      warn(
        "github",
        `cannot read the ${githubName} environment (HTTP ${settings.status})`,
        "use a GITHUB_TOKEN that can read the repository's environments",
      ),
    ];
  }
  const findings: Finding[] = [];
  if (environment === "production") {
    const reviewed = (settings.body?.protection_rules ?? []).some(
      (rule) => rule.type === "required_reviewers",
    );
    const variable = reviewed
      ? undefined
      : await getJson<{ value?: string }>(
          context,
          `https://api.github.com/repos/${repository}/actions/variables/${promoteFromStaging}`,
          io.env.GITHUB_TOKEN,
        );
    findings.push(
      reviewed
        ? ok("github", "production requires a reviewer's approval")
        : variable && variable.status !== 200 && variable.status !== 404
          ? warn(
              "github",
              `production has no required reviewer, and the repository variable ${promoteFromStaging} cannot be read (HTTP ${variable.status})`,
              `use a GITHUB_TOKEN that can read Actions variables, or add a reviewer in Settings → Environments → production`,
            )
          : variable?.body?.value === "true"
            ? fail(
                "github",
                `${promoteFromStaging} is true but production has no required reviewer, so every Staging run's production job stops before deploying`,
                `add a reviewer in Settings → Environments → production, or delete the repository variable ${promoteFromStaging}`,
              )
            : warn(
                "github",
                "production has no required reviewers, so the typed build-ID confirmation is the only safeguard before promotion",
                "add required reviewers in Settings → Environments → production; GitHub offers them on public repositories, and on private ones only with GitHub Enterprise",
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
        `cannot list the ${githubName} environment's secrets (HTTP ${secrets.status})`,
        "use a token with read access to environment secrets",
      ),
    );
    return findings;
  }
  const present = new Set(secrets.body.secrets.map((secret) => secret.name));
  const needed = environmentSecrets(config, environment);
  const absent = needed.filter((name) => !present.has(name));
  findings.push(
    absent.length === 0
      ? ok(
          "github",
          `the ${githubName} environment has every secret the project needs`,
        )
      : fail(
          "github",
          `the ${githubName} environment is missing ${absent.join(", ")}`,
          `add them in Settings → Environments → ${githubName} → Environment secrets`,
        ),
  );
  const buildNames = [...buildSecrets(config).keys()].sort();
  if (buildNames.length > 0) {
    const repositorySecrets = await getJson<{ secrets?: { name: string }[] }>(
      context,
      `https://api.github.com/repos/${repository}/actions/secrets?per_page=100`,
      io.env.GITHUB_TOKEN,
    );
    if (!repositorySecrets.body?.secrets) {
      findings.push(
        warn(
          "github",
          `cannot list the repository's secrets (HTTP ${repositorySecrets.status})`,
          "use a token with read access to the repository's Actions secrets",
        ),
      );
    } else {
      const stored = new Set(
        repositorySecrets.body.secrets.map((secret) => secret.name),
      );
      const lacking = buildNames.filter((name) => !stored.has(name));
      if (lacking.length > 0)
        findings.push(
          fail(
            "github",
            `the repository is missing the build secrets ${lacking.join(", ")}`,
            "run setup, or add them in Settings → Secrets and variables → Actions → Repository secrets",
          ),
        );
    }
  }
  const publicNames = [...appPublic(config).keys()].sort();
  if (publicNames.length === 0) return findings;
  const variables = await getJson<{ variables?: { name: string }[] }>(
    context,
    `${api}/variables?per_page=30`,
    io.env.GITHUB_TOKEN,
  );
  if (!variables.body?.variables) {
    findings.push(
      warn(
        "github",
        `cannot list the ${githubName} environment's variables (HTTP ${variables.status})`,
        "use a token with read access to environment variables",
      ),
    );
    return findings;
  }
  const defined = new Set(
    variables.body.variables.map((variable) => variable.name),
  );
  const undefinedNames = publicNames.filter((name) => !defined.has(name));
  if (undefinedNames.length > 0) {
    findings.push(
      fail(
        "github",
        `the ${githubName} environment is missing the public values ${undefinedNames.join(", ")}`,
        `run setup --env ${githubName}, or add them in Settings → Environments → ${githubName} → Environment variables`,
      ),
    );
  }
  return findings;
};
