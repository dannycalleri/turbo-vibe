import { isBuildId } from "./builds.js";
import type { Io } from "./io.js";
import { githubSignedIn } from "./setup.js";
import {
  currentRepository,
  type StagingBuild,
  stagingBuilds,
} from "./staging-builds.js";

const short = (sha: string) => sha.slice(0, 12);

interface Run {
  databaseId: number;
  url: string;
}

async function gh(args: readonly string[], io: Io) {
  return io
    .capture("gh", args, { cwd: io.cwd, env: io.env, quiet: true })
    .catch(() => undefined);
}

async function latestRun(
  repo: string,
  workflow: string,
  login: string,
  io: Io,
): Promise<Run | undefined> {
  const listed = await gh(
    [
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      workflow,
      "--event",
      "workflow_dispatch",
      "--user",
      login,
      "--limit",
      "1",
      "--json",
      "databaseId,url",
    ],
    io,
  );
  if (listed?.code !== 0) return undefined;
  try {
    const [run] = JSON.parse(listed.stdout) as Partial<Run>[];
    return typeof run?.databaseId === "number" && typeof run.url === "string"
      ? { databaseId: run.databaseId, url: run.url }
      : undefined;
  } catch {
    return undefined;
  }
}

async function choose(
  builds: StagingBuild[],
  io: Io,
): Promise<string | undefined | "cancelled"> {
  if (!io.prompts) return undefined;
  const listed = builds.slice(0, 10);
  const [newest] = listed;
  if (!newest) return undefined;
  const picked = await io.prompts.select(
    "Which build goes to production?",
    listed.map((build, index) => ({
      value: build.sha,
      label: `${short(build.sha)}  ${build.subject}`,
      hint: `${index === 0 ? "newest, " : ""}passed staging ${build.passedAt}`,
    })),
    newest.sha,
  );
  return picked ?? "cancelled";
}

export async function ship(
  {
    buildId,
    workflow,
    allowDeletions = false,
  }: { buildId?: string; workflow: string; allowDeletions?: boolean },
  io: Io,
): Promise<number> {
  if (buildId !== undefined && !isBuildId(buildId)) {
    io.stderr(`${JSON.stringify(buildId)} is not a full commit SHA\n`);
    return 1;
  }
  if (buildId === undefined && !io.prompts) {
    io.stderr("without a terminal, ship needs --build-id <sha>\n");
    return 1;
  }
  if (!(await githubSignedIn(io))) {
    io.stderr(
      "ship starts the Deploy to production workflow with the GitHub CLI: run gh auth login, then ship again\n",
    );
    return 1;
  }
  const [repo, user] = await Promise.all([
    currentRepository(io).catch(() => undefined),
    gh(["api", "user", "--jq", ".login"], io),
  ]);
  const login = user?.code === 0 ? user.stdout.trim() : "";
  if (!repo || !login) {
    io.stderr(
      "cannot tell this folder's GitHub repository or your GitHub login: run ship in a clone of the project, with gh signed in\n",
    );
    return 1;
  }
  const listed = await stagingBuilds(io, repo);
  if (!Array.isArray(listed) && buildId === undefined) {
    io.stderr(`cannot list the builds that passed staging: ${listed.error}\n`);
    return 1;
  }
  if (!Array.isArray(listed))
    io.stdout(
      `cannot list the builds that passed staging (${listed.error}), so ship cannot tell whether ${short(buildId ?? "")} is a rollback\n`,
    );
  const builds = Array.isArray(listed) ? listed : [];
  if (buildId === undefined && builds.length === 0) {
    io.stderr(
      "no build has passed staging yet: merge a change to main, and ship once its Staging run passes\n",
    );
    return 1;
  }
  const chosen = buildId ?? (await choose(builds, io));
  if (chosen === "cancelled") return 130;
  if (chosen === undefined) return 1;
  const index = builds.findIndex((build) => build.sha === chosen);
  const [newest] = builds;
  if (index < 0 && Array.isArray(listed))
    io.stdout(
      `GitHub lists no passing staging deployment for ${short(chosen)}; the run checks the build records and stops unless it passed\n`,
    );
  const rollback =
    index > 0 && newest
      ? `${short(chosen)} is older than the newest build ${short(newest.sha)}`
      : undefined;
  if (io.prompts) {
    const go = await io.prompts.confirm(
      rollback
        ? `Roll production back? ${rollback}.`
        : `Start Deploy to production with ${short(chosen)}?`,
    );
    if (go === undefined) return 130;
    if (!go) {
      io.stdout("nothing started\n");
      return 0;
    }
  } else if (rollback) {
    io.stdout(`this is a rollback: ${rollback}\n`);
  }
  const before = await latestRun(repo, workflow, login, io);
  const started = await io.capture(
    "gh",
    [
      "workflow",
      "run",
      workflow,
      "--repo",
      repo,
      "-f",
      `confirm-build=${chosen}`,
      ...(allowDeletions ? ["-f", "allow-deletions=true"] : []),
    ],
    { cwd: io.cwd, env: io.env },
  );
  if (started.code !== 0) {
    io.stderr(
      `gh could not start ${workflow}${started.stderr ? `: ${started.stderr.trim()}` : ""}\n`,
    );
    return 1;
  }
  let run: Run | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    run = await latestRun(repo, workflow, login, io);
    if (run && run.databaseId !== before?.databaseId) break;
    run = undefined;
    await io.sleep(2_000);
  }
  io.stdout(
    `started Deploy to production with ${chosen}${run ? `: ${run.url}` : `; find the run under ${workflow} in the Actions tab`}\nA required reviewer of the production environment approves it there; without one, it runs at once.\n`,
  );
  return 0;
}
