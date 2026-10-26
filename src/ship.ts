import type { Io } from "./io.js";
import { githubSignedIn } from "./setup.js";
import { type StagingBuild, stagingBuilds } from "./staging-builds.js";

const short = (sha: string) => sha.slice(0, 12);

async function latestRun(
  workflow: string,
  io: Io,
): Promise<{ id: string; url: string } | undefined> {
  const listed = await io
    .capture(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        workflow,
        "--limit",
        "1",
        "--json",
        "databaseId,url",
        "--jq",
        '.[0] | "\\(.databaseId) \\(.url)"',
      ],
      { cwd: io.cwd, env: io.env, quiet: true },
    )
    .catch(() => undefined);
  const [id, url] = listed?.code === 0 ? listed.stdout.trim().split(" ") : [];
  return id && url ? { id, url } : undefined;
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
  { buildId, workflow }: { buildId?: string; workflow: string },
  io: Io,
): Promise<number> {
  if (buildId !== undefined && !/^[0-9a-f]{40}$/.test(buildId)) {
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
  const listed = await stagingBuilds(io);
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
  if (io.prompts) {
    const question =
      index > 0 && newest
        ? `Roll production back to ${short(chosen)}, older than the newest build ${short(newest.sha)}?`
        : `Start Deploy to production with ${short(chosen)}?`;
    const go = await io.prompts.confirm(question);
    if (go === undefined) return 130;
    if (!go) {
      io.stdout("nothing started\n");
      return 0;
    }
  }
  const before = await latestRun(workflow, io);
  const started = await io.capture(
    "gh",
    ["workflow", "run", workflow, "-f", `confirm-build=${chosen}`],
    { cwd: io.cwd, env: io.env },
  );
  if (started.code !== 0) {
    io.stderr(
      `gh could not start ${workflow}${started.stderr ? `: ${started.stderr.trim()}` : ""}\n`,
    );
    return 1;
  }
  let run: { id: string; url: string } | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    run = await latestRun(workflow, io);
    if (run && run.id !== before?.id) break;
    run = undefined;
    await io.sleep(2_000);
  }
  io.stdout(
    `started Deploy to production with ${chosen}${run ? `: ${run.url}` : `; find the run under ${workflow} in the Actions tab`}\nA required reviewer of the production environment approves it there; without one, it runs at once.\n`,
  );
  return 0;
}
