import { adapterFor } from "./adapters/index.js";
import { cloudflare } from "./checks/cloudflare.js";
import { installsWithNpmCi, localTools, npmLockfile } from "./checks/local.js";
import { stateBucket } from "./checks/state.js";
import type { Check, CheckContext, Finding } from "./checks/types.js";
import { fail } from "./checks/types.js";
import { github, supabase, vercel, workos } from "./checks/vendors.js";
import type { Config, EnvironmentName } from "./config/schema.js";
import type { Io } from "./io.js";

export function checksFor(config: Config): Check[] {
  const secrets = new Set(
    Object.values(config.services).flatMap(
      (service) => adapterFor(service.target).secrets,
    ),
  );
  return [
    localTools,
    stateBucket,
    ...(secrets.has("CLOUDFLARE_API_TOKEN") ? [cloudflare] : []),
    ...(secrets.has("SUPABASE_ACCESS_TOKEN") ? [supabase] : []),
    ...(secrets.has("WORKOS_API_KEY") ? [workos] : []),
    ...(secrets.has("VERCEL_API_TOKEN") ? [vercel] : []),
    ...(Object.values(config.services).some(
      (service) =>
        service.kind === "frontend" && installsWithNpmCi(service.build.command),
    )
      ? [npmLockfile]
      : []),
    github,
  ];
}

export async function runChecks(
  checks: readonly Check[],
  context: CheckContext,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const check of checks) {
    try {
      findings.push(...(await check(context)));
    } catch (error) {
      findings.push(
        fail(
          check.name || "check",
          `could not finish: ${error instanceof Error ? error.message : String(error)}`,
          "rerun check; if it fails again, the service may be unreachable from this machine",
        ),
      );
    }
  }
  return findings;
}

const labels = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

export function formatFindings(
  environment: string,
  findings: readonly Finding[],
): string {
  const lines: string[] = [environment];
  for (const finding of findings) {
    lines.push(
      `  ${labels[finding.severity]}  ${finding.check}: ${finding.message}`,
    );
    if (finding.fix && finding.severity !== "ok")
      lines.push(`        fix: ${finding.fix}`);
  }
  const failures = findings.filter(
    (finding) => finding.severity === "fail",
  ).length;
  lines.push(
    failures === 0
      ? `${environment} is ready`
      : `${environment} has ${failures} problem${failures === 1 ? "" : "s"}`,
  );
  return `${lines.join("\n")}\n`;
}

export async function check(
  config: Config,
  environment: EnvironmentName,
  io: Io,
  {
    nodeVersion = process.versions.node,
    checks = checksFor(config),
    configDir,
  }: {
    nodeVersion?: string;
    checks?: readonly Check[];
    configDir?: string;
  } = {},
): Promise<number> {
  const findings = await runChecks(checks, {
    config,
    environment,
    io,
    nodeVersion,
    ...(configDir ? { configDir } : {}),
  });
  io.stdout(formatFindings(environment, findings));
  return findings.some((finding) => finding.severity === "fail") ? 1 : 0;
}
