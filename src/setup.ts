import { checksFor, formatFindings, runChecks } from "./check.js";
import type { Finding } from "./checks/types.js";
import type { Config, EnvironmentName } from "./config/schema.js";
import { environmentSecrets } from "./deploy.js";
import type { Io } from "./io.js";
import { appSecrets } from "./secrets.js";
import {
  cloudflareSecrets,
  type Provided,
  setupCloudflare,
} from "./setup/cloudflare.js";
import {
  supabaseSecrets,
  vercelSecrets,
  workosKeyProblem,
} from "./setup/vendors.js";

export interface SetupOptions {
  env: readonly string[];
  repo?: string;
  replace?: readonly string[];
}

export function defaultEnvironments(config: Config): string[] {
  return ["staging", "production", ...(config.previews ? ["preview"] : [])];
}

export function kindOf(environment: string): EnvironmentName {
  return environment === "production" ? "production" : "staging";
}

interface GitHubEnvironment {
  can_admins_bypass?: boolean;
  protection_rules?: {
    type: string;
    wait_timer?: number;
    prevent_self_review?: boolean;
    reviewers?: { type: string; reviewer: { id: number } }[];
  }[];
  deployment_branch_policy?: {
    protected_branches: boolean;
    custom_branch_policies: boolean;
  } | null;
}

interface Stored {
  entered: Record<string, string>;
  kept: string[];
}

type Read<T> =
  | { status: "found"; value: T }
  | { status: "missing" }
  | { status: "failed" };

async function gh(
  args: readonly string[],
  io: Io,
  input?: string,
): Promise<{ code: number; stdout: string } | undefined> {
  try {
    return await io.capture("gh", args, {
      cwd: io.cwd,
      env: io.env,
      ...(input === undefined ? {} : { input }),
    });
  } catch {
    return undefined;
  }
}

async function ghRead<T>(args: readonly string[], io: Io): Promise<Read<T>> {
  const result = await gh(args, io);
  if (result?.code === 0) {
    try {
      return { status: "found", value: JSON.parse(result.stdout) as T };
    } catch {
      return { status: "failed" };
    }
  }
  // gh api exits 1 for every HTTP error and prints GitHub's error body on stdout.
  return result && /"message":\s*"Not Found"/.test(result.stdout)
    ? { status: "missing" }
    : { status: "failed" };
}

async function repository(
  options: SetupOptions,
  io: Io,
): Promise<string | undefined> {
  if (options.repo) return options.repo;
  if (io.env.GITHUB_REPOSITORY) return io.env.GITHUB_REPOSITORY;
  const viewed = await gh(
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    io,
  );
  return viewed?.code === 0 ? viewed.stdout.trim() || undefined : undefined;
}

const mainOnly = { protected_branches: false, custom_branch_policies: true };

// A PUT resets every environment setting it leaves out, so the existing ones are sent back.
function settings(
  existing: GitHubEnvironment,
  reviewers: readonly { type: string; id: number }[],
  policy: GitHubEnvironment["deployment_branch_policy"],
): string[] {
  const args: string[] = [];
  for (const reviewer of reviewers)
    args.push(
      "-f",
      `reviewers[][type]=${reviewer.type}`,
      "-F",
      `reviewers[][id]=${reviewer.id}`,
    );
  const rules = existing.protection_rules ?? [];
  const review = rules.find((rule) => rule.type === "required_reviewers");
  if (reviewers.length > 0 && review?.prevent_self_review !== undefined)
    args.push("-F", `prevent_self_review=${review.prevent_self_review}`);
  if (policy)
    args.push(
      "-F",
      `deployment_branch_policy[protected_branches]=${policy.protected_branches}`,
      "-F",
      `deployment_branch_policy[custom_branch_policies]=${policy.custom_branch_policies}`,
    );
  const timer = rules.find((rule) => rule.type === "wait_timer")?.wait_timer;
  if (timer !== undefined) args.push("-F", `wait_timer=${timer}`);
  if (existing.can_admins_bypass !== undefined)
    args.push("-F", `can_admins_bypass=${existing.can_admins_bypass}`);
  return args;
}

function existingReviewers(
  existing: GitHubEnvironment,
): { type: string; id: number }[] {
  return (
    existing.protection_rules
      ?.find((rule) => rule.type === "required_reviewers")
      ?.reviewers?.map(({ type, reviewer }) => ({ type, id: reviewer.id })) ??
    []
  );
}

async function onlyMain(repo: string, name: string, io: Io): Promise<void> {
  const path = `repos/${repo}/environments/${name}/deployment-branch-policies`;
  const listed = await ghRead<{ branch_policies?: { name: string }[] }>(
    ["api", path],
    io,
  );
  const rules = listed.status === "found" ? listed.value.branch_policies : [];
  const added =
    listed.status === "found" &&
    (rules?.some((rule) => rule.name === "main") ||
      (
        await gh(
          ["api", "-X", "POST", path, "-f", "name=main", "-f", "type=branch"],
          io,
        )
      )?.code === 0);
  if (!added) {
    io.stdout(
      `warn  github: could not add main to ${name}'s deployment branches, so ${name} may now accept deployments from no branch; add main in Settings → Environments → ${name} → Deployment branches\n`,
    );
    return;
  }
  const others = (rules ?? [])
    .map((rule) => rule.name)
    .filter((rule) => rule !== "main");
  io.stdout(
    others.length === 0
      ? `github: ${name} accepts deployments from main only\n`
      : `warn  github: ${name} also accepts deployments from ${others.join(", ")}; remove those rules in Settings → Environments → ${name} → Deployment branches, or those branches receive ${name}'s secrets\n`,
  );
}

async function protect(
  repo: string,
  name: "staging" | "production",
  existing: GitHubEnvironment,
  io: Io,
): Promise<void> {
  const kept = existingReviewers(existing);
  let reviewer: { id: number; login: string } | undefined;
  if (name === "production" && kept.length === 0) {
    const user = await ghRead<{ id: number; login: string }>(
      ["api", "user"],
      io,
    );
    if (user.status === "found") reviewer = user.value;
    else
      io.stdout(
        "warn  github: cannot read the signed-in GitHub user, so production has no required reviewer; every promotion still needs the typed build ID\n",
      );
  } else if (name === "production")
    io.stdout("github: production already requires a reviewer\n");
  const policy = existing.deployment_branch_policy;
  const restricted =
    policy?.custom_branch_policies === true && !policy.protected_branches;
  const path = `repos/${repo}/environments/${name}`;
  const put = async (reviewers: { type: string; id: number }[]) =>
    (
      await gh(
        ["api", "-X", "PUT", path, ...settings(existing, reviewers, mainOnly)],
        io,
      )
    )?.code === 0;
  if (reviewer) {
    if (await put([...kept, { type: "User", id: reviewer.id }])) {
      io.stdout(
        `github: production now requires a review by ${reviewer.login}\n`,
      );
      await onlyMain(repo, name, io);
      return;
    }
    // GitHub offers required reviewers on fewer plans than deployment-branch rules, so the rule is tried alone.
    io.stdout(
      "warn  github: GitHub did not accept a required reviewer on production (a private repository needs GitHub Enterprise for it); every promotion still needs the typed build ID\n",
    );
  }
  if (!restricted && !(await put(kept))) {
    io.stdout(
      `warn  github: GitHub did not accept a deployment-branch rule on ${name} (a private repository needs GitHub Pro, Team or Enterprise for it), so a workflow on any branch could ask for ${name}'s secrets\n`,
    );
    return;
  }
  await onlyMain(repo, name, io);
}

async function presentSecrets(
  repo: string,
  environment: string,
  io: Io,
): Promise<Set<string> | undefined> {
  const listed = await ghRead<{ name: string }[]>(
    ["secret", "list", "--env", environment, "--repo", repo, "--json", "name"],
    io,
  );
  if (listed.status !== "found") {
    io.stderr(`cannot list the secrets of ${environment} in ${repo}\n`);
    return undefined;
  }
  return new Set(listed.value.map((secret) => secret.name));
}

function question(config: Config, environment: string, name: string): string {
  const workos = kindOf(environment);
  const services = appSecrets(config).get(name);
  if (services)
    return `${environment} ${name} (declared by ${services.join(", ")}: the value for ${environment})`;
  if (name === "WORKOS_API_KEY")
    return `${environment} WORKOS_API_KEY (API Keys of the WorkOS ${workos} environment)`;
  if (name === "WORKOS_CLIENT_ID")
    return `${environment} WORKOS_CLIENT_ID (on the application page linked from the API key's row)`;
  return `${environment} ${name}`;
}

async function storeSecrets(
  config: Config,
  repo: string,
  environment: string,
  present: ReadonlySet<string>,
  provided: Provided,
  askSecret: (question: string) => Promise<string>,
  io: Io,
): Promise<Stored | undefined> {
  const needed = environmentSecrets(config, kindOf(environment));
  const store = (name: string) =>
    !present.has(name) || provided.replace.includes(name);
  const kept = needed.filter((name) => !store(name));
  const entered: Record<string, string> = {};
  if (kept.length > 0) io.stdout(`${environment}: kept ${kept.join(", ")}\n`);
  for (const name of needed.filter(store)) {
    let value = provided.values[name]?.trim();
    while (value === undefined) {
      const answer = (
        await askSecret(question(config, environment, name))
      ).trim();
      const problem =
        name === "WORKOS_API_KEY" && answer
          ? workosKeyProblem(environment, answer)
          : undefined;
      if (problem) io.stdout(`${problem}\n`);
      else value = answer;
    }
    if (!value) {
      io.stdout(`${environment}: ${name} skipped, nothing entered\n`);
      continue;
    }
    const stored = await gh(
      ["secret", "set", name, "--env", environment, "--repo", repo],
      io,
      value,
    );
    if (stored?.code !== 0) {
      io.stderr(`cannot store ${name} in ${environment}\n`);
      return undefined;
    }
    entered[name] = value;
    io.stdout(`${environment}: stored ${name}\n`);
  }
  return { entered, kept };
}

// A kept secret has no value in this run, so its check can only say it is not set.
function withoutKept(
  finding: Finding,
  kept: readonly string[],
): Finding | undefined {
  if (!finding.unset) return finding;
  const unset = finding.unset.filter((name) => !kept.includes(name));
  if (unset.length === 0) return undefined;
  if (unset.length === finding.unset.length) return finding;
  return {
    ...finding,
    message: `${unset.join(", ")} ${unset.length === 1 ? "is" : "are"} not set`,
    unset,
  };
}

async function verify(
  config: Config,
  environment: string,
  { entered, kept }: Stored,
  github: Record<string, string>,
  io: Io,
): Promise<boolean> {
  const secrets = new Set(environmentSecrets(config, kindOf(environment)));
  // The shell can hold its own values for these names; the checks must see only what this run stored.
  const env = {
    ...Object.fromEntries(
      Object.entries(io.env).filter(([name]) => !secrets.has(name)),
    ),
    ...entered,
    ...github,
  };
  const findings = (
    await runChecks(checksFor(config), {
      config,
      environment: kindOf(environment),
      githubEnvironment: environment,
      io: { ...io, env },
      nodeVersion: process.versions.node,
    })
  ).flatMap((finding) => withoutKept(finding, kept) ?? []);
  io.stdout(formatFindings(environment, findings));
  if (kept.length > 0)
    io.stdout(
      `${environment}: kept ${kept.join(", ")}; GitHub does not return their values, so this run did not check them (--replace sets one again and checks it)\n`,
    );
  return !findings.some((finding) => finding.severity === "fail");
}

export async function setup(
  config: Config,
  options: SetupOptions,
  io: Io,
): Promise<number> {
  const { askSecret } = io;
  if (!io.ask || !askSecret) {
    io.stderr(
      "setup asks for secrets, so it needs a terminal; run it in one\n",
    );
    return 1;
  }
  const invalid = options.env.filter((name) => !/^[A-Za-z0-9._-]+$/.test(name));
  if (invalid.length > 0) {
    io.stderr(
      `${invalid.join(", ")} cannot name a GitHub environment; use letters, digits, ".", "-" and "_"\n`,
    );
    return 1;
  }
  const needed = [
    ...new Set(
      options.env.flatMap((name) => environmentSecrets(config, kindOf(name))),
    ),
  ];
  const unknown = (options.replace ?? []).filter(
    (name) => !needed.includes(name),
  );
  if (unknown.length > 0) {
    io.stderr(
      `--replace ${unknown.join(", ")}: this project does not use ${unknown.length === 1 ? "that secret" : "those secrets"}; it uses ${needed.join(", ")}\n`,
    );
    return 1;
  }
  const auth = await gh(["auth", "status"], io);
  if (!auth) {
    io.stderr(
      "setup needs the GitHub CLI; install it from https://cli.github.com, then run gh auth login\n",
    );
    return 1;
  }
  if (auth.code !== 0) {
    io.stderr("the GitHub CLI is not signed in; run gh auth login\n");
    return 1;
  }
  const repo = await repository(options, io);
  if (!repo) {
    io.stderr(
      "cannot tell which GitHub repository to set up; pass --repo owner/name\n",
    );
    return 1;
  }

  for (const name of options.env) {
    const path = `repos/${repo}/environments/${name}`;
    let found = await ghRead<GitHubEnvironment>(["api", path], io);
    if (found.status === "missing") {
      const created = await gh(["api", "-X", "PUT", path], io);
      if (created?.code !== 0) {
        io.stderr(`cannot create the GitHub environment ${name} in ${repo}\n`);
        return 1;
      }
      io.stdout(`github: environment ${name} created\n`);
      found = { status: "found", value: {} };
    } else if (found.status === "found") {
      io.stdout(`github: environment ${name} exists\n`);
    } else {
      io.stderr(
        `cannot read the GitHub environment ${name} in ${repo}; nothing was changed in it, rerun setup\n`,
      );
      return 1;
    }
    if (name === "staging" || name === "production")
      await protect(repo, name, found.value, io);
  }
  const present = new Map<string, Set<string>>();
  for (const name of options.env) {
    const names = await presentSecrets(repo, name, io);
    if (!names) return 1;
    for (const replaced of options.replace ?? []) names.delete(replaced);
    present.set(name, names);
  }
  const lacking = (names: readonly string[]) =>
    [...present].some(([environment, existing]) => {
      const own = environmentSecrets(config, kindOf(environment));
      return names.some((name) => own.includes(name) && !existing.has(name));
    });
  let provided = new Map<string, Provided>();
  let afterStoring = async () => {};
  if (needed.includes("CLOUDFLARE_ZONE_ID") && lacking(cloudflareSecrets)) {
    const created = await setupCloudflare(config, present, askSecret, io);
    if (!created) return 1;
    provided = created.provided;
    afterStoring = created.offerToDeleteBootstrap;
  }
  const shared: Record<string, string> = {};
  if (lacking(["SUPABASE_ACCESS_TOKEN", "SUPABASE_ORGANIZATION"])) {
    const values = await supabaseSecrets(config, askSecret, io);
    if (!values) return 1;
    Object.assign(shared, values);
  }
  if (lacking(["VERCEL_API_TOKEN", "VERCEL_TEAM_ID"])) {
    const values = await vercelSecrets(askSecret, io);
    if (!values) return 1;
    Object.assign(shared, values);
  }
  for (const name of present.keys()) {
    const own = provided.get(name) ?? { values: {}, replace: [] };
    provided.set(name, { ...own, values: { ...shared, ...own.values } });
  }
  const stored = new Map<string, Stored>();
  for (const [name, names] of present) {
    const result = await storeSecrets(
      config,
      repo,
      name,
      names,
      provided.get(name) ?? { values: {}, replace: [] },
      askSecret,
      io,
    );
    if (!result) return 1;
    stored.set(name, result);
  }
  // The new tokens' values exist only in GitHub now, so the bootstrap token may go only after every store succeeded.
  await afterStoring();
  const token = await gh(["auth", "token"], io);
  const github = {
    GITHUB_REPOSITORY: repo,
    ...(token?.code === 0 ? { GITHUB_TOKEN: token.stdout.trim() } : {}),
  };
  let ready = true;
  for (const [name, result] of stored)
    ready = (await verify(config, name, result, github, io)) && ready;
  return ready ? 0 : 1;
}
