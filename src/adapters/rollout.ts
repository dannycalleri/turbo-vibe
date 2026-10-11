import type { Io } from "../io.js";

interface Application {
  id: string;
  name: string;
  version: number;
}

interface Rollout {
  status: string;
  target_version: number;
  progress?: { updated_instances?: number; total_instances?: number };
}

const pollMs = 5_000;
const requestAttempts = 5;
const sigtermNoticeAfterMs = 90_000;
// Cloudflare kills an instance 15 minutes after SIGTERM; two more minutes cover starting its replacement.
export const rolloutLimitMs = 17 * 60_000;

async function result<T>(
  url: string,
  token: string | undefined,
  io: Io,
): Promise<T | undefined> {
  for (let attempt = 1; attempt <= requestAttempts; attempt++) {
    try {
      const response = await io.fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return ((await response.json()) as { result: T }).result;
    } catch {}
    if (attempt < requestAttempts) await io.sleep(pollMs);
  }
  return undefined;
}

// `wrangler deploy` returns once the rollout has started; the new image serves only once every instance is replaced.
export async function awaitRollout(
  applicationName: string,
  io: Io,
): Promise<number> {
  const api = `https://api.cloudflare.com/client/v4/accounts/${io.env.CLOUDFLARE_ACCOUNT_ID}/containers/applications`;
  const token = io.env.CLOUDFLARE_API_TOKEN;
  const application = (
    await result<Application[]>(
      `${api}?name=${encodeURIComponent(applicationName)}`,
      token,
      io,
    )
  )?.find((candidate) => candidate.name === applicationName);
  if (!application) {
    io.stderr(
      `cannot find container application ${applicationName} to follow its rollout\n`,
    );
    return 1;
  }

  let reported = "";
  for (let waited = 0; ; waited += pollMs) {
    const rollouts = await result<Rollout[]>(
      `${api}/${application.id}/rollouts`,
      token,
      io,
    );
    if (!rollouts) {
      io.stderr(`cannot read the rollout of ${applicationName}\n`);
      return 1;
    }
    // A first deploy creates the application with its image and starts no rollout.
    const rollout = rollouts.find(
      (candidate) => candidate.target_version === application.version,
    );
    if (!rollout || rollout.status === "completed") {
      if (rollout)
        io.stdout(`${applicationName}: every instance runs the new image\n`);
      return 0;
    }
    if (rollout.status === "replaced") {
      io.stderr(
        `the rollout of ${applicationName} was replaced by a newer deploy\n`,
      );
      return 1;
    }
    if (rollout.status === "reverted") {
      io.stderr(
        `Cloudflare reverted the rollout of ${applicationName} to the previous image\n`,
      );
      return 1;
    }

    const updated = rollout.progress?.updated_instances ?? 0;
    const total = rollout.progress?.total_instances ?? 0;
    const progress = `${updated}/${total} instances on the new image`;
    if (progress !== reported) {
      io.stdout(`${applicationName}: ${progress}\n`);
      reported = progress;
    }
    if (waited === sigtermNoticeAfterMs) {
      io.stdout(
        `${applicationName}: still waiting for ${total - updated} instance(s) on the previous image to exit. Cloudflare stops an instance with SIGTERM and kills it after 15 minutes, so a main process that ignores SIGTERM holds the rollout until then\n`,
      );
    }
    if (waited >= rolloutLimitMs) {
      io.stderr(
        `the rollout of ${applicationName} did not finish within ${rolloutLimitMs / 60_000} minutes (${progress}); the new Worker is live, and requests can still reach the previous image\n`,
      );
      return 1;
    }
    await io.sleep(pollMs);
  }
}
