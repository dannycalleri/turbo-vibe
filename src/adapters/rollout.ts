import type { Io } from "../io.js";

interface Application {
  id: string;
  name: string;
}

interface Rollout {
  id: string;
  status: string;
  created_at: string;
  progress?: { updated_instances?: number; total_instances?: number };
}

const pollMs = 5_000;
const requestAttempts = 5;
const sigtermNoticeAfterMs = 90_000;
// Cloudflare kills an instance 15 minutes after SIGTERM; two more minutes cover starting its replacement.
export const rolloutLimitMs = 17 * 60_000;

function api(io: Io): string {
  return `https://api.cloudflare.com/client/v4/accounts/${io.env.CLOUDFLARE_ACCOUNT_ID}/containers/applications`;
}

async function result<T>(url: string, io: Io): Promise<T | undefined> {
  for (let attempt = 1; attempt <= requestAttempts; attempt++) {
    try {
      const response = await io.fetch(url, {
        headers: { authorization: `Bearer ${io.env.CLOUDFLARE_API_TOKEN}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return ((await response.json()) as { result: T }).result;
    } catch {}
    if (attempt < requestAttempts) await io.sleep(pollMs);
  }
  return undefined;
}

// null: no such application yet; undefined: Cloudflare did not answer.
async function application(
  name: string,
  io: Io,
): Promise<Application | null | undefined> {
  const listed = await result<Application[]>(
    `${api(io)}?name=${encodeURIComponent(name)}`,
    io,
  );
  return (
    listed && (listed.find((candidate) => candidate.name === name) ?? null)
  );
}

async function rollouts(id: string, io: Io): Promise<Rollout[] | undefined> {
  return result<Rollout[]>(`${api(io)}/${id}/rollouts`, io);
}

// The application's own version can lag behind the rollout a deploy starts, so the deploy's
// rollout is the one that was not there before it.
export async function existingRollouts(
  name: string,
  io: Io,
): Promise<ReadonlySet<string> | undefined> {
  const found = await application(name, io);
  if (found === null) return new Set();
  const listed = found && (await rollouts(found.id, io));
  if (!listed) {
    io.stderr(`cannot read the rollouts of ${name} before deploying\n`);
    return undefined;
  }
  return new Set(listed.map((rollout) => rollout.id));
}

// `wrangler deploy` returns once the rollout has started; the new image serves only once every instance is replaced.
export async function awaitRollout(
  name: string,
  before: ReadonlySet<string>,
  io: Io,
): Promise<number> {
  const found = await application(name, io);
  if (!found) {
    io.stderr(
      `cannot find container application ${name} to follow its rollout\n`,
    );
    return 1;
  }

  let reported = "";
  for (let waited = 0; ; waited += pollMs) {
    const listed = await rollouts(found.id, io);
    if (!listed) {
      io.stderr(`cannot read the rollout of ${name}\n`);
      return 1;
    }
    const rollout = listed
      .filter((candidate) => !before.has(candidate.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!rollout) {
      io.stdout(`${name}: no rollout started, so no instance to replace\n`);
      return 0;
    }
    if (rollout.status === "completed") {
      io.stdout(`${name}: every instance runs the new image\n`);
      return 0;
    }
    if (rollout.status === "replaced") {
      io.stderr(`the rollout of ${name} was replaced by a newer deploy\n`);
      return 1;
    }
    if (rollout.status === "reverted") {
      io.stderr(
        `Cloudflare reverted the rollout of ${name} to the previous image\n`,
      );
      return 1;
    }

    const updated = rollout.progress?.updated_instances ?? 0;
    const total = rollout.progress?.total_instances ?? 0;
    const progress = `${updated}/${total} instances on the new image`;
    if (progress !== reported) {
      io.stdout(`${name}: ${progress}\n`);
      reported = progress;
    }
    if (waited === sigtermNoticeAfterMs) {
      io.stdout(
        `${name}: still waiting for ${total - updated} instance(s) on the previous image to exit. Cloudflare stops an instance with SIGTERM and kills it after 15 minutes, so a main process that ignores SIGTERM holds the rollout until then\n`,
      );
    }
    if (waited >= rolloutLimitMs) {
      io.stderr(
        `the rollout of ${name} did not finish within ${rolloutLimitMs / 60_000} minutes (${progress}); the new Worker is live, and requests can still reach the previous image\n`,
      );
      return 1;
    }
    await io.sleep(pollMs);
  }
}
