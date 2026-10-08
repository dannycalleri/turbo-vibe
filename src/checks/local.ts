import type { Check } from "./types.js";
import { fail, ok } from "./types.js";

function atLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.replace(/^v/, "").split(".").map(Number);
  for (const [index, wanted] of minimum.entries()) {
    const actual = parts[index] ?? 0;
    if (actual !== wanted) return actual > wanted;
  }
  return true;
}

export const localTools: Check = async ({ io, nodeVersion }) => {
  const findings = [
    atLeast(nodeVersion, [24])
      ? ok("node", `Node ${nodeVersion}`)
      : fail(
          "node",
          `Node ${nodeVersion} is older than 24`,
          "install the active Node.js LTS (24 or later)",
        ),
  ];
  const tofu = await io
    .capture("tofu", ["version", "-json"], { cwd: io.cwd, env: io.env })
    .catch(() => undefined);
  let version: string | undefined;
  try {
    version =
      tofu?.code === 0
        ? (JSON.parse(tofu.stdout) as { terraform_version?: string })
            .terraform_version
        : undefined;
  } catch {
    version = undefined;
  }
  if (tofu && !version) {
    findings.push(
      fail(
        "tofu",
        "could not read `tofu version -json`",
        "run `tofu version -json` and fix what it reports; OpenTofu 1.10 or later is needed",
      ),
    );
    return findings;
  }
  findings.push(
    !version
      ? fail(
          "tofu",
          "OpenTofu (`tofu`) is not on PATH",
          "install OpenTofu 1.10 or later: https://opentofu.org/docs/intro/install/",
        )
      : atLeast(version, [1, 10])
        ? ok("tofu", `OpenTofu ${version}`)
        : fail(
            "tofu",
            `OpenTofu ${version} is older than 1.10, which state locking on R2 needs`,
            "upgrade OpenTofu to 1.10 or later",
          ),
  );
  return findings;
};
