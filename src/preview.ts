import { createHash } from "node:crypto";
import { adapterFor } from "./adapters/index.js";
import { apply, destroy, missingVariables } from "./apply.js";
import type { Config, PreviewEnvironment } from "./config/schema.js";
import { deploy, type Project, smoke } from "./deploy.js";
import { requiredSecrets } from "./infrastructure.js";
import type { Io } from "./io.js";
import { migrate } from "./migrate.js";
import { hostnameFor, hostOf, layout } from "./origins.js";

const maxLabel = 63;
// A certificate's common name holds at most 64 characters; Vercel issues one per hostname.
const maxHostname = 64;

export function previewEnvironment(
  branch: string,
  stagingHostname: string,
  distinct = false,
): PreviewEnvironment {
  const slug = branch
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // `live-run-…` belongs to the live tests' branch `live run <n>`, which git refuses as a branch name.
  const reserved =
    slug.startsWith("live-run-") && !/^live run \d+$/.test(branch);
  const named =
    /^[a-z]/.test(slug) && !reserved ? slug : `pr-${slug}`.replace(/-+$/, "");
  const room = Math.min(
    maxLabel - "api-".length - (stagingHostname.split(".")[0] ?? "").length - 1,
    maxHostname - "api-".length - stagingHostname.length - 1,
  );
  // Normalizing can map two branches to one name (fix/login, fix-login); the hash keeps their previews apart.
  // A plain name that already looks hashed could equal another branch's hashed name.
  if (
    !distinct &&
    named === branch &&
    named.length <= room &&
    !/-[0-9a-f]{6}$/.test(named)
  )
    return `preview-${named}`;
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 6);
  return `preview-${named.slice(0, room - hash.length - 1).replace(/-+$/, "")}-${hash}`;
}

// A branch named like a configured host, such as `api` next to `api-staging.<domain>`, must not take that host over.
export function previewFor(branch: string, config: Config): PreviewEnvironment {
  const stagingHostname = hostnameFor(config, "staging");
  const configured = new Set(
    (["staging", "production"] as const).flatMap((environment) => {
      const hosts = layout(config, environment);
      return [hosts.hostname, hosts.backendHostname];
    }),
  );
  const plain = previewEnvironment(branch, stagingHostname);
  const hosts = layout(config, plain);
  return configured.has(hosts.hostname) || configured.has(hosts.backendHostname)
    ? previewEnvironment(branch, stagingHostname, true)
    : plain;
}

function databaseBlocksPreviews({ config }: Project): string | undefined {
  const free = Object.entries(config.services).find(
    ([, service]) => service.kind === "database" && service.plan !== "paid",
  );
  return free
    ? `database \`${free[0]}\` is on the free Supabase plan, and a preview needs a database branch, which only paid plans have`
    : undefined;
}

export async function deployPreview(
  project: Project,
  branch: string,
  buildId: string,
  io: Io,
): Promise<number> {
  const { config } = project;
  if (!config.previews) {
    io.stderr(
      "previews are not enabled; set `previews: true` in turbo-vibe.yaml\n",
    );
    return 1;
  }
  const blocked = databaseBlocksPreviews(project);
  if (blocked) {
    io.stdout(`no preview: ${blocked}\n`);
    return 0;
  }
  const environment = previewFor(branch, config);
  for (const step of [
    () => apply(config, environment, io),
    () => migrate(project, environment, io),
    () => deploy(project, environment, { buildId, dryRun: false }, io),
    () => smoke(config, environment, buildId, io),
  ]) {
    const code = await step();
    if (code !== 0) return code;
  }
  for (const url of previewUrls(config, environment))
    io.stdout(`preview: ${url}\n`);
  return 0;
}

export function previewUrls(
  config: Config,
  environment: PreviewEnvironment,
): string[] {
  const hosts = layout(config, environment);
  const services = Object.values(config.services);
  const pages = new Set(
    services
      .filter((service) => service.kind === "frontend")
      .map((service) => hostOf(hosts, service)),
  );
  const urls = services.flatMap((service) => {
    if (service.kind === "frontend")
      return [`https://${hostOf(hosts, service)}/`];
    if (service.kind !== "backend") return [];
    const host = hostOf(hosts, service);
    // A backend with no page on its hostname is routed only under /api/, so its root reaches no origin and Cloudflare answers 522.
    return [
      pages.has(host) ? `https://${host}/` : `https://${host}/api/health`,
    ];
  });
  return [...new Set(urls)];
}

export async function removePreview(
  project: Project,
  branch: string,
  io: Io,
): Promise<number> {
  const { config } = project;
  const environment = previewFor(branch, config);
  if (missingVariables(requiredSecrets(config), io)) return 1;
  const hosts = layout(config, environment);
  for (const [name, service] of Object.entries(config.services)) {
    const adapter = adapterFor(service.target);
    if (!adapter.remove) continue;
    const code = await adapter.remove({
      config,
      name,
      service,
      environment,
      hostname: hostOf(hosts, service),
      backendHostname: hosts.backendHostname,
      io,
    });
    if (code !== 0) return code;
  }
  return destroy(config, environment, io);
}
