import { checksFor, formatFindings, runChecks } from "./check.js";
import type { Finding } from "./checks/types.js";
import type { Config, EnvironmentName } from "./config/schema.js";
import { environmentSecrets } from "./deploy.js";
import type { Io } from "./io.js";
import {
  cloudflareSecrets,
  type Provided,
  setupCloudflare,
} from "./setup/cloudflare.js";

export interface SetupOptions {
  env: readonly EnvironmentName[];
  repo?: string;
}

interface GitHubEnvironment {
  can_admins_bypass?: boolean;
  protection_rules?: { type: string; wait_timer?: number }[];
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

// A PUT resets every environment setting it leaves out, so the existing ones are sent back.
function keptSettings(existing: GitHubEnvironment): string[] {
  const kept: string[] = [];
  const policy = existing.deployment_branch_policy;
  if (policy)
    kept.push(
      "-F",
      `deployment_branch_policy[protected_branches]=${policy.protected_branches}`,
      "-F",
      `deployment_branch_policy[custom_branch_policies]=${policy.custom_branch_policies}`,
    );
  const timer = existing.protection_rules?.find(
    (rule) => rule.type === "wait_timer",
  )?.wait_timer;
  if (timer !== undefined) kept.push("-F", `wait_timer=${timer}`);
  if (existing.can_admins_bypass !== undefined)
    kept.push("-F", `can_admins_bypass=${existing.can_admins_bypass}`);
  return kept;
}

async function requireReviewer(
  repo: string,
  existing: GitHubEnvironment,
  io: Io,
): Promise<void> {
  if (
    existing.protection_rules?.some(
      (rule) => rule.type === "required_reviewers",
    )
  ) {
    io.stdout("github: production already requires a reviewer\n");
    return;
  }
  const user = await ghRead<{ id: number; login: string }>(["api", "user"], io);
  if (user.status !== "found") {
    io.stdout(
      "warn  github: cannot read the signed-in GitHub user, so production has no required reviewer; every promotion still needs the typed build ID\n",
    );
    return;
  }
  const added = await gh(
    [
      "api",
      "-X",
      "PUT",
      `repos/${repo}/environments/production`,
      "-f",
      "reviewers[][type]=User",
      "-F",
      `reviewers[][id]=${user.value.id}`,
      ...keptSettings(existing),
    ],
    io,
  );
  if (added?.code === 0) {
    io.stdout(
      `github: production now requires a review by ${user.value.login}\n`,
    );
    return;
  }
  io.stdout(
    "warn  github: GitHub did not accept a required reviewer on production (a private repository on GitHub Free has none); every promotion still needs the typed build ID\n",
  );
}

async function presentSecrets(
  repo: string,
  environment: EnvironmentName,
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

async function storeSecrets(
  config: Config,
  repo: string,
  environment: EnvironmentName,
  present: ReadonlySet<string>,
  provided: Provided,
  askSecret: (question: string) => Promise<string>,
  io: Io,
): Promise<Stored | undefined> {
  const needed = environmentSecrets(config);
  const store = (name: string) =>
    !present.has(name) || provided.replace.includes(name);
  const kept = needed.filter((name) => !store(name));
  const entered: Record<string, string> = {};
  if (kept.length > 0) io.stdout(`${environment}: kept ${kept.join(", ")}\n`);
  for (const name of needed.filter(store)) {
    const value = (
      provided.values[name] ?? (await askSecret(`${environment} ${name}`))
    ).trim();
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
  environment: EnvironmentName,
  { entered, kept }: Stored,
  github: Record<string, string>,
  io: Io,
): Promise<boolean> {
  const secrets = new Set(environmentSecrets(config));
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
      environment,
      io: { ...io, env },
      nodeVersion: process.versions.node,
    })
  ).flatMap((finding) => withoutKept(finding, kept) ?? []);
  io.stdout(formatFindings(environment, findings));
  if (kept.length > 0)
    io.stdout(
      `${environment}: kept ${kept.join(", ")}, verified by check in the environment's workflow\n`,
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
    if (name === "production") await requireReviewer(repo, found.value, io);
  }
  const present = new Map<EnvironmentName, Set<string>>();
  for (const name of options.env) {
    const names = await presentSecrets(repo, name, io);
    if (!names) return 1;
    present.set(name, names);
  }
  const needed = environmentSecrets(config);
  const lacking = (names: readonly string[]) =>
    [...present.values()].some((existing) =>
      names.some((name) => needed.includes(name) && !existing.has(name)),
    );
  let provided = new Map<EnvironmentName, Provided>();
  let afterStoring = async () => {};
  if (needed.includes("CLOUDFLARE_ZONE_ID") && lacking(cloudflareSecrets)) {
    const created = await setupCloudflare(config, present, askSecret, io);
    if (!created) return 1;
    provided = created.provided;
    afterStoring = created.offerToDeleteBootstrap;
  }
  const stored = new Map<EnvironmentName, Stored>();
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
