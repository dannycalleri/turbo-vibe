import { BuildStore } from "../builds.js";
import { stateSecrets } from "../infrastructure.js";
import type { Check, Finding } from "./types.js";
import { fail, ok } from "./types.js";

export const stateBucket: Check = async ({ config, io }) => {
  const absent = stateSecrets.filter((name) => !io.env[name]);
  if (absent.length > 0) {
    return [
      {
        ...fail(
          "state bucket",
          `${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} not set`,
          "create the R2 bucket and an R2 API token with Object Read & Write on it, then set TURBO_VIBE_STATE_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and CLOUDFLARE_ACCOUNT_ID",
        ),
        unset: absent,
      },
    ];
  }
  const bucket = io.env.TURBO_VIBE_STATE_BUCKET;
  const store = new BuildStore(io, config.project);
  const key = `${config.project}/check/lock-probe-${Date.now()}`;
  const findings: Finding[] = [];
  try {
    const first = await store.putIfAbsent(key, "probe");
    if (first < 200 || first > 299) {
      return [
        fail(
          "state bucket",
          `cannot write to bucket ${bucket}: HTTP ${first}`,
          `give the R2 token in AWS_ACCESS_KEY_ID Object Read & Write on ${bucket}, and check the bucket exists in account CLOUDFLARE_ACCOUNT_ID`,
        ),
      ];
    }
    const second = await store.putIfAbsent(key, "probe");
    findings.push(
      second === 412
        ? ok(
            "state bucket",
            `bucket ${bucket} rejects a second conditional create, so state locking is safe`,
          )
        : fail(
            "state bucket",
            `bucket ${bucket} accepted a second conditional create (HTTP ${second}), so two runs could hold the state lock at once`,
            "use an R2 bucket (S3-compatible storage that enforces If-None-Match), and keep deployments serialized per environment",
          ),
    );
  } finally {
    await store.remove(key).catch(() => undefined);
  }
  return findings;
};
