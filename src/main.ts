import { dirname, resolve } from "node:path";
import { Command, CommanderError, Option } from "commander";
import { apply } from "./apply.js";
import { loadConfigFile } from "./config/load.js";
import { type EnvironmentName, environmentNames } from "./config/schema.js";
import { deploy, type Project, smoke, test } from "./deploy.js";
import type { Io } from "./io.js";
import { migrate } from "./migrate.js";
import { derivePlan, formatPlan } from "./plan.js";

export type { Io } from "./io.js";

export async function main(argv: readonly string[], io: Io): Promise<number> {
  let exitCode = 0;
  const program = new Command("turbo-vibe")
    .description("Deploy a project's services from turbo-vibe.yaml.")
    .option("-c, --config <file>", "project config file", "turbo-vibe.yaml")
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  async function loadProject(): Promise<Project | undefined> {
    const file = resolve(io.cwd, program.opts<{ config: string }>().config);
    const result = await loadConfigFile(file);
    if (result.ok) return { config: result.config, configDir: dirname(file) };
    for (const { line, message } of result.problems) {
      io.stderr(
        line > 0 ? `${file}:${line}: ${message}\n` : `${file}: ${message}\n`,
      );
    }
    exitCode = 1;
    return undefined;
  }

  const environmentOption = () =>
    new Option("-e, --env <environment>", "environment to act on")
      .choices(environmentNames)
      .makeOptionMandatory();
  const buildIdOption = () =>
    new Option(
      "--build-id <id>",
      "the build being deployed, such as the commit SHA",
    ).makeOptionMandatory();

  program
    .command("plan")
    .description(
      "show the services each environment would run, without changing anything",
    )
    .action(async () => {
      const project = await loadProject();
      if (project) io.stdout(`${formatPlan(derivePlan(project.config))}\n`);
    });

  program
    .command("apply")
    .description(
      "create or update an environment's infrastructure with OpenTofu",
    )
    .addOption(environmentOption())
    .action(async (options: { env: EnvironmentName }) => {
      const project = await loadProject();
      if (project) exitCode = await apply(project.config, options.env, io);
    });

  program
    .command("migrate")
    .description("create the database roles and apply pending migrations")
    .addOption(environmentOption())
    .action(async (options: { env: EnvironmentName }) => {
      const project = await loadProject();
      if (project) exitCode = await migrate(project, options.env, io);
    });

  program
    .command("test")
    .description("run each service's test command")
    .action(async () => {
      const project = await loadProject();
      if (project) exitCode = await test(project, io);
    });

  program
    .command("deploy")
    .description("build each service and ship it to an environment")
    .addOption(environmentOption())
    .addOption(buildIdOption())
    .option(
      "--dry-run",
      "build and validate without uploading or needing credentials",
    )
    .action(
      async (options: {
        env: EnvironmentName;
        buildId: string;
        dryRun?: boolean;
      }) => {
        const project = await loadProject();
        if (project) {
          exitCode = await deploy(
            project,
            options.env,
            { buildId: options.buildId, dryRun: options.dryRun ?? false },
            io,
          );
        }
      },
    );

  program
    .command("smoke")
    .description(
      "check that every service in an environment reports the build ID",
    )
    .addOption(environmentOption())
    .addOption(buildIdOption())
    .action(async (options: { env: EnvironmentName; buildId: string }) => {
      const project = await loadProject();
      if (project)
        exitCode = await smoke(
          project.config,
          options.env,
          options.buildId,
          io,
        );
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  return exitCode;
}
