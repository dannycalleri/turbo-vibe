import type { Io } from "./io.js";

export interface StagingBuild {
  sha: string;
  subject: string;
  passedAt: string;
}

interface Deployment {
  commitOid: string;
  latestStatus: { state: string; createdAt: string } | null;
  commit: { messageHeadline: string } | null;
}

const query = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    deployments(environments: ["staging"], first: 50, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { commitOid latestStatus { state createdAt } commit { messageHeadline } }
    }
  }
}`;

async function repository(io: Io): Promise<string | undefined> {
  if (io.env.GITHUB_REPOSITORY) return io.env.GITHUB_REPOSITORY;
  const viewed = await io.capture(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { cwd: io.cwd, env: io.env, quiet: true },
  );
  return viewed.code === 0 ? viewed.stdout.trim() || undefined : undefined;
}

export async function stagingBuilds(
  io: Io,
): Promise<StagingBuild[] | { error: string }> {
  const repo = await repository(io).catch(() => undefined);
  const [owner, name] = repo?.split("/") ?? [];
  if (!owner || !name)
    return { error: "cannot tell which GitHub repository this is" };
  const answer = await io
    .capture(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
      ],
      { cwd: io.cwd, env: io.env, quiet: true },
    )
    .catch((error: unknown) => ({
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }));
  if (answer.code !== 0)
    return {
      error: answer.stderr?.trim() || `gh api graphql exited ${answer.code}`,
    };
  let nodes: Deployment[];
  try {
    nodes =
      JSON.parse(answer.stdout).data?.repository?.deployments?.nodes ?? [];
  } catch {
    return { error: "GitHub answered with something other than JSON" };
  }
  const builds: StagingBuild[] = [];
  for (const node of nodes) {
    if (node.latestStatus?.state !== "SUCCESS") continue;
    if (builds.some((build) => build.sha === node.commitOid)) continue;
    builds.push({
      sha: node.commitOid,
      subject: node.commit?.messageHeadline ?? "",
      passedAt: node.latestStatus.createdAt,
    });
  }
  return builds.sort((a, b) => b.passedAt.localeCompare(a.passedAt));
}

const named = (build: StagingBuild) =>
  `\`${build.sha}\` (${build.subject}), which passed staging at ${build.passedAt}`;

export function describePromotion(
  builds: StagingBuild[] | { error: string },
  buildId?: string,
): string {
  const records = "The production job checks the build records";
  if (!Array.isArray(builds))
    return `Cannot list the staging deployments (${builds.error}). ${records}.`;
  const [newest] = builds;
  if (!buildId) {
    return newest
      ? `Promoting the newest build: ${named(newest)}.`
      : `GitHub lists no staging deployment that passed. ${records}, and stops when no build passed.`;
  }
  const index = builds.findIndex((build) => build.sha === buildId);
  const build = builds[index];
  if (!build)
    return `GitHub lists no passing staging deployment for \`${buildId}\`. ${records}, and stops unless the build passed.`;
  const rollback =
    newest && index > 0
      ? ` This is a rollback: the newest build is ${named(newest)}.`
      : "";
  return `Promoting ${named(build)}.${rollback}`;
}
