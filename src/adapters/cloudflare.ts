import { rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkBuildId } from "../smoke.js";
import { recordedOrBuilt, staticBuild } from "./assets.js";
import { awaitRollout } from "./rollout.js";
import type { Adapter, DeployContext, ServiceContext } from "./types.js";
import {
  buildIdPath,
  wranglerDeployArgs,
  wranglerPushArgs,
  writeWorker,
} from "./wrangler.js";

type Backend = Extract<DeployContext["service"], { kind: "backend" }>;

function imageTag(context: DeployContext): string {
  return `${context.config.project}-${context.name}:${context.buildId}`;
}

function dockerBuild(
  context: DeployContext,
  backend: Backend,
  tag: string,
): Promise<number> {
  const { io, configDir } = context;
  const dockerfile = resolve(configDir, backend.build.dockerfile);
  return io.run(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "--build-arg",
      `BUILD_ID=${context.buildId}`,
      "--file",
      dockerfile,
      "--tag",
      tag,
      backend.build.context
        ? resolve(configDir, backend.build.context)
        : dirname(dockerfile),
    ],
    { cwd: configDir, env: io.env },
  );
}

async function buildAndPush(
  context: DeployContext,
  backend: Backend,
): Promise<string | number> {
  const { io, configDir } = context;
  const tag = imageTag(context);
  const options = { cwd: configDir, env: io.env };
  const built = await dockerBuild(context, backend, tag);
  if (built !== 0) return built;
  const pushed = await io.run(process.execPath, wranglerPushArgs(tag), options);
  if (pushed !== 0) return pushed;
  const inspected = await io.capture(
    "docker",
    ["image", "inspect", "--format", "{{json .RepoDigests}}", tag],
    options,
  );
  const repository = `registry.cloudflare.com/${io.env.CLOUDFLARE_ACCOUNT_ID}/${tag.split(":")[0]}@`;
  const digest = (JSON.parse(inspected.stdout || "[]") as string[]).find(
    (ref) => ref.startsWith(repository),
  );
  if (inspected.code !== 0 || !digest) {
    io.stderr(
      `cannot find the pushed digest of ${tag} in the Cloudflare registry\n`,
    );
    return 1;
  }
  return digest;
}

// A deploy replaces running instances with SIGTERM, and Cloudflare waits 15 minutes before killing one that ignores it.
async function stopsOnSigterm(
  context: DeployContext,
  backend: Backend,
): Promise<number> {
  const { io, configDir } = context;
  const tag = imageTag(context);
  const options = { cwd: configDir, env: io.env };
  const built = await dockerBuild(context, backend, tag);
  if (built !== 0) return built;
  const started = await io.capture(
    "docker",
    ["run", "--detach", "--platform", "linux/amd64", "--env", "PORT=8080", tag],
    options,
  );
  const id = started.stdout.trim();
  if (started.code !== 0 || !id) {
    io.stderr(`cannot start ${tag} to check that it stops on SIGTERM\n`);
    return 1;
  }
  try {
    await io.sleep(3_000);
    const running = await io.capture(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", id],
      options,
    );
    if (running.stdout.trim() !== "true") {
      io.stdout(
        `${context.name}: the container exited by itself within 3 seconds, so whether it stops on SIGTERM is not checked\n`,
      );
      return 0;
    }
    await io.run("docker", ["stop", "--time", "10", id], options);
    const exited = await io.capture(
      "docker",
      ["inspect", "--format", "{{.State.ExitCode}}", id],
      options,
    );
    if (exited.stdout.trim() === "137") {
      io.stderr(
        `${context.name}: the container ignored SIGTERM and was killed after 10 seconds. Cloudflare replaces a running container on every deploy by sending SIGTERM and waits up to 15 minutes before killing it, so make its main process exit on SIGTERM: handle the signal, or start it through an init such as tini\n`,
      );
      return 1;
    }
    io.stdout(`${context.name}: the container stops on SIGTERM\n`);
    return 0;
  } finally {
    await io.run("docker", ["rm", "--force", id], options);
  }
}

const secrets = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
] as const;

export function workerName({
  config,
  name,
  environment,
}: ServiceContext): string {
  return `${config.project}-${name}-${environment}`;
}

function servedFrontend({ config, name }: ServiceContext): string | undefined {
  return Object.entries(config.services).find(
    ([, service]) => service.kind === "frontend" && service.serve_with === name,
  )?.[0];
}

async function wranglerDeploy(
  context: DeployContext,
  file: string,
  secrets: Readonly<Record<string, string>> = {},
): Promise<number> {
  const secretsFile =
    !context.dryRun && Object.keys(secrets).length > 0
      ? join(dirname(file), "secrets.json")
      : undefined;
  if (secretsFile) {
    await writeFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  }
  try {
    return await context.io.run(
      process.execPath,
      wranglerDeployArgs(file, context.dryRun, secretsFile),
      { cwd: dirname(file), env: context.io.env },
    );
  } finally {
    if (secretsFile) await rm(secretsFile, { force: true });
  }
}

export const cloudflareContainer: Adapter = {
  target: "cloudflare-container",
  kind: "backend",
  hostsStaticAssets: true,
  secrets,
  outputs: ["url", "worker"],
  plan(context) {
    const route = servedFrontend(context)
      ? `${context.hostname}/*`
      : `${context.hostname}/api/*`;
    return {
      cloudflare: {
        workers: { [workerName(context)]: { routes: [route] } },
        hostnames: [context.hostname],
      },
    };
  },
  async deploy(context) {
    if (context.service.kind !== "backend")
      throw new Error(`${context.name} is not a backend`);
    if (context.recorded && !context.recorded.image) {
      context.io.stderr(
        `build ${context.buildId} has no recorded image for ${context.name}\n`,
      );
      return { code: 1 };
    }
    if (context.dryRun && !context.recorded) {
      const stopped = await stopsOnSigterm(context, context.service);
      if (stopped !== 0) return { code: stopped };
    }
    let image = context.recorded?.image;
    if (!image && !context.dryRun) {
      const pushed = await buildAndPush(context, context.service);
      if (typeof pushed === "number") return { code: pushed };
      image = pushed;
    }
    const frontend = servedFrontend(context);
    const name = workerName(context);
    const assets = frontend ? context.assetsDirs[frontend] : undefined;
    const file = await writeWorker(join(context.workDir, name), {
      name,
      buildId: context.buildId,
      configDir: context.configDir,
      backend: context.service,
      secretNames: context.secretNames,
      ...(image ? { image } : {}),
      ...(assets ? { assets } : {}),
    });
    let code = await wranglerDeploy(context, file, context.secrets);
    if (code === 0 && !context.dryRun)
      code = await awaitRollout(`${name}-backend`, context.io);
    return { code, ...(image ? { outputs: { image } } : {}) };
  },
  async remove(context) {
    const { io } = context;
    const api = `https://api.cloudflare.com/client/v4/accounts/${io.env.CLOUDFLARE_ACCOUNT_ID}/containers/applications`;
    const headers = { authorization: `Bearer ${io.env.CLOUDFLARE_API_TOKEN}` };
    const listed = await io.fetch(api, { headers });
    if (!listed.ok) {
      io.stderr(
        `cannot list Cloudflare container applications (HTTP ${listed.status})\n`,
      );
      return 1;
    }
    const body = (await listed.json()) as
      | { result?: { id: string; name: string }[] }
      | { id: string; name: string }[];
    const applications = Array.isArray(body) ? body : (body.result ?? []);
    for (const application of applications.filter(
      (app) => app.name === `${workerName(context)}-backend`,
    )) {
      const deleted = await io.fetch(`${api}/${application.id}`, {
        method: "DELETE",
        headers,
      });
      if (!deleted.ok && deleted.status !== 404) {
        io.stderr(
          `cannot delete container application ${application.name} (HTTP ${deleted.status})\n`,
        );
        return 1;
      }
    }
    return 0;
  },
  smoke(context) {
    return checkBuildId(
      {
        url: `https://${context.hostname}/api/health`,
        read: async (response) => {
          const body: unknown = await response.json().catch(() => undefined);
          const buildId = (body as { build_id?: unknown } | undefined)
            ?.build_id;
          return typeof buildId === "string" ? buildId : undefined;
        },
      },
      context.buildId,
      context.io,
    );
  },
};

export const cloudflareStatic: Adapter = {
  target: "cloudflare-static",
  kind: "frontend",
  hostsStaticAssets: true,
  secrets,
  outputs: ["url", "worker"],
  plan(context) {
    if (context.service.kind === "frontend" && context.service.serve_with) {
      return {};
    }
    return {
      cloudflare: {
        workers: {
          [workerName(context)]: { routes: [`${context.hostname}/*`] },
        },
        hostnames: [context.hostname],
      },
    };
  },
  async deploy(context) {
    const { service } = context;
    if (service.kind !== "frontend")
      throw new Error(`${context.name} is not a frontend`);
    const assets = await recordedOrBuilt(context, () => staticBuild(context));
    if (typeof assets === "number") return { code: assets };
    const result = {
      assetsDir: assets.dir,
      ...(assets.outputs ? { outputs: assets.outputs } : {}),
    };
    if (service.serve_with) return { code: 0, ...result };

    const name = workerName(context);
    const file = await writeWorker(join(context.workDir, name), {
      name,
      buildId: context.buildId,
      configDir: context.configDir,
      assets: assets.dir,
    });
    return { code: await wranglerDeploy(context, file), ...result };
  },
  smoke(context) {
    return checkBuildId(
      {
        url: `https://${context.hostname}${buildIdPath}`,
        read: async (response) => (await response.text()).trim(),
      },
      context.buildId,
      context.io,
    );
  },
};
