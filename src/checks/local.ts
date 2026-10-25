import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Check, Finding } from "./types.js";
import { fail, ok, warn } from "./types.js";

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

const npmLockfiles = ["package-lock.json", "npm-shrinkwrap.json"];

export function installsWithNpmCi(command: string): boolean {
  return /^\s*npm\s+ci\b/.test(command);
}

// Production deploys staging's build and never installs, so only environments that build are checked.
export const npmLockfile: Check = async ({
  config,
  configDir,
  environment,
  io,
}) => {
  if (environment === "production") return [];
  const base = configDir ?? io.cwd;
  const findings: Finding[] = [];
  for (const [name, service] of Object.entries(config.services)) {
    if (
      service.kind !== "frontend" ||
      !installsWithNpmCi(service.build.command)
    )
      continue;
    const folder = resolve(base, service.build.root ?? ".");
    const where = relative(base, folder) || ".";
    const fix = `run npm install in ${where} and commit package-lock.json`;
    const folders = [folder];
    const inside = !where.startsWith("..") && !isAbsolute(where);
    for (let up = folder; inside && up !== base; ) {
      up = dirname(up);
      folders.push(up);
    }
    const present = await Promise.all(
      folders.flatMap((candidate) =>
        npmLockfiles.map((file) =>
          access(join(candidate, file)).then(
            () => true,
            () => false,
          ),
        ),
      ),
    );
    if (!present.some(Boolean)) {
      findings.push(
        fail(
          "lockfile",
          `${name} builds with npm ci, but ${where} has no package-lock.json`,
          fix,
        ),
      );
      continue;
    }
    const result = await io
      .capture(
        "npm",
        [
          "ci",
          "--dry-run",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--json",
        ],
        { cwd: folder, env: io.env, quiet: true },
      )
      .catch(() => undefined);
    let code: string | undefined;
    try {
      code = (JSON.parse(result?.stdout ?? "") as { error?: { code?: string } })
        .error?.code;
    } catch {
      code = undefined;
    }
    findings.push(
      result?.code === 0
        ? ok("lockfile", `${name}: npm ci accepts the lockfile in ${where}`)
        : code === "EUSAGE"
          ? fail(
              "lockfile",
              `${name}: npm ci refuses the lockfile in ${where}, which does not match package.json`,
              fix,
            )
          : warn(
              "lockfile",
              `${name}: could not ask npm whether the lockfile in ${where} matches package.json${code ? ` (${code})` : ""}`,
              `run npm ci --dry-run in ${where} to see why`,
            ),
    );
  }
  return findings;
};
