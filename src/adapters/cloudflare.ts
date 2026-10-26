import { rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backendPrefix, buildIdVariable, healthPath } from "../contract.js";
import { type BackendPort, backendPort } from "../port.js";
import { checkBuildId } from "../smoke.js";
import { hasNotFoundPage, recordedOrBuilt, staticBuild } from "./assets.js";
import { awaitRollout, existingRollouts } from "./rollout.js";
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
      `${buildIdVariable}=${context.buildId}`,
      ...Object.keys(context.buildSecrets).flatMap((name) => [
        "--secret",
        `id=${name},env=${name}`,
      ]),
      "--file",
      dockerfile,
      "--tag",
      tag,
      backend.build.context
        ? resolve(configDir, backend.build.context)
        : dirname(dockerfile),
    ],
    { cwd: configDir, env: context.buildEnv },
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

// A new container application's first start, or the switch from the previous build's instances, can take minutes: six seconds apart, these wait five.
export const containerSwitchAttempts = 50;

const healthBuildId = async (response: Response) => {
  const body: unknown = await response.json().catch(() => undefined);
  const buildId = (body as { build_id?: unknown } | undefined)?.build_id;
  return typeof buildId === "string" ? buildId : undefined;
};

// A deploy replaces running instances with SIGTERM, and Cloudflare waits 15 minutes before killing one that ignores it.
async function meetsContract(
  context: DeployContext,
  backend: Backend,
  { port: listening, source }: BackendPort,
): Promise<number | "unchecked"> {
  const { io, configDir } = context;
  const tag = imageTag(context);
  const options = { cwd: configDir, env: context.buildEnv };
  const built = await dockerBuild(context, backend, tag);
  if (built !== 0) return built;
  const started = await io.capture(
    "docker",
    [
      "run",
      "--detach",
      "--platform",
      "linux/amd64",
      "--env",
      `PORT=${listening}`,
      "--publish",
      `127.0.0.1::${listening}`,
      tag,
    ],
    options,
  );
  const id = started.stdout.trim();
  if (started.code !== 0 || !id) {
    io.stderr(`cannot start ${tag} to check its health route and SIGTERM\n`);
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
        `${context.name}: the container exited by itself within 3 seconds, so its health route and whether it stops on SIGTERM are not checked\n`,
      );
      return "unchecked";
    }
    const published = await io.capture(
      "docker",
      ["port", id, `${listening}/tcp`],
      options,
    );
    const port = published.stdout.trim().split("\n")[0]?.split(":").pop();
    if (published.code !== 0 || !/^\d+$/.test(port ?? "")) {
      io.stderr(
        `${context.name}: the container published no port for ${listening} (${source}), so its health route is not reachable; it may have stopped (see docker logs) or the Docker daemon may not be local\n`,
      );
      return 1;
    }
    const health = await checkBuildId(
      {
        url: `http://127.0.0.1:${port}${healthPath}`,
        read: healthBuildId,
      },
      context.buildId,
      io,
      { attempts: 10, delayMs: 1_000 },
    );
    if (!health.ok) {
      io.stderr(
        `${context.name}: ${health.message}. The smoke test after every deploy asks GET ${healthPath} on port ${listening} (${source}, also given as PORT; set container.port to change it) for JSON whose build_id is the ${buildIdVariable} build argument, so listen on 0.0.0.0, serve that route, and put ARG ${buildIdVariable} and ENV ${buildIdVariable}=$${buildIdVariable} in the Dockerfile's final stage\n`,
      );
      return 1;
    }
    io.stdout(
      `${context.name}: the container answers ${healthPath} with build ${context.buildId}\n`,
    );
    await io.capture("docker", ["stop", "--timeout", "10", id], options);
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
    await io.capture("docker", ["rm", "--force", id], options);
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
      : `${context.hostname}${backendPrefix}*`;
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
    const port = await backendPort(context.service, context.configDir);
    let unchecked = false;
    if (context.dryRun && !context.recorded) {
      const checked = await meetsContract(context, context.service, port);
      if (checked === "unchecked") unchecked = true;
      else if (checked !== 0) return { code: checked };
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
    const served = frontend ? context.config.services[frontend] : undefined;
    const notFound = served?.kind === "frontend" ? served.not_found : undefined;
    const file = await writeWorker(join(context.workDir, name), {
      name,
      buildId: context.buildId,
      configDir: context.configDir,
      backend: context.service,
      port: port.port,
      secretNames: context.secretNames,
      ...(image ? { image } : {}),
      ...(assets ? { assets } : {}),
      ...(notFound ? { notFound } : {}),
    });
    const application = `${name}-backend`;
    const before = context.dryRun
      ? new Set<string>()
      : await existingRollouts(application, context.io);
    if (!before) return { code: 1 };
    let code = await wranglerDeploy(context, file, context.secrets);
    if (code === 0 && !context.dryRun)
      code = await awaitRollout(application, before, context.io);
    return {
      code,
      ...(image ? { outputs: { image } } : {}),
      ...(unchecked ? { unchecked } : {}),
    };
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
        url: `https://${context.hostname}${healthPath}`,
        read: healthBuildId,
        ...(context.headers ? { headers: context.headers } : {}),
      },
      context.buildId,
      context.io,
      { switchingAttempts: containerSwitchAttempts },
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
    const token = context.outputs.analytics_token;
    const assets = await recordedOrBuilt(context, () => staticBuild(context), {
      noindex: context.environment !== "production",
      ...(typeof token === "string" && token !== ""
        ? { analyticsToken: token }
        : {}),
    });
    if (typeof assets === "number") return { code: assets };
    if (
      service.not_found === "404-page" &&
      !(await hasNotFoundPage(assets.dir))
    ) {
      context.io.stderr(
        `${context.name}: not_found is 404-page, but the build output (${service.build.output}) has no 404.html at its root\n`,
      );
      return { code: 1 };
    }
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
      ...(service.not_found ? { notFound: service.not_found } : {}),
    });
    return { code: await wranglerDeploy(context, file), ...result };
  },
  smoke(context) {
    return checkBuildId(
      {
        url: `https://${context.hostname}${buildIdPath}`,
        read: async (response) => (await response.text()).trim(),
        ...(context.headers ? { headers: context.headers } : {}),
      },
      context.buildId,
      context.io,
    );
  },
};
