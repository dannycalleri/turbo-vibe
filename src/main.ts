import { dirname, resolve } from "node:path";
import { Command, CommanderError, Option } from "commander";
import { apply, plan } from "./apply.js";
import { check } from "./check.js";
import { jsonSchema } from "./config/json-schema.js";
import { loadConfigFile } from "./config/load.js";
import { type EnvironmentName, environmentNames } from "./config/schema.js";
import { deploy, type Project, promote, smoke, test } from "./deploy.js";
import { choices, init, labelled } from "./init.js";
import type { Io } from "./io.js";
import { migrate } from "./migrate.js";
import { derivePlan, formatPlan } from "./plan.js";
import { deployPreview, removePreview } from "./preview.js";
import { major, version } from "./version.js";

export type { Io } from "./io.js";

export async function main(argv: readonly string[], io: Io): Promise<number> {
  let exitCode = 0;
  const program = new Command("turbo-vibe")
    .description(
      "Take a prototype to production: staging and production from turbo-vibe.yaml, the build tested on staging promoted unchanged after approval.",
    )
    .version(version)
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
      "show the services each environment would run; with --env, what applying it would create, change, replace or delete. Changes nothing",
    )
    .addOption(
      new Option(
        "-e, --env <environment>",
        "compare with this environment's deployed state",
      ).choices(environmentNames),
    )
    .action(async (options: { env?: EnvironmentName }) => {
      const project = await loadProject();
      if (!project) return;
      if (options.env) {
        exitCode = await plan(project.config, options.env, io);
      } else {
        io.stdout(`${formatPlan(derivePlan(project.config))}\n`);
      }
    });

  program
    .command("apply")
    .description(
      "create or update an environment's infrastructure with OpenTofu",
    )
    .addOption(environmentOption())
    .option(
      "--allow-deletions",
      "apply even when the plan deletes or replaces resources",
    )
    .action(
      async (options: { env: EnvironmentName; allowDeletions?: boolean }) => {
        const project = await loadProject();
        if (project) {
          exitCode = await apply(project.config, options.env, io, {
            allowDeletions: options.allowDeletions === true,
          });
        }
      },
    );

  program
    .command("schema", { hidden: true })
    .description("print the JSON Schema of turbo-vibe.yaml")
    .action(() => {
      io.stdout(`${JSON.stringify(jsonSchema(major), null, 2)}\n`);
    });

  program
    .command("init")
    .description(
      "write turbo-vibe.yaml and the staging and production workflows into this repository",
    )
    .option("--name <name>", "project name")
    .option("--domain <domain>", "production domain")
    .option("--backend <target>", labelled(choices.backend))
    .option("--frontend <target>", labelled(choices.frontend))
    .option("--database <target>", labelled(choices.database))
    .option("--identity <target>", labelled(choices.identity))
    .option("--force", "replace files that already exist")
    .action(async (options: Record<string, string | boolean | undefined>) => {
      const { force, ...given } = options;
      exitCode = await init(
        given as Record<string, string>,
        { force: force === true },
        io,
      );
    });

  program
    .command("check")
    .description(
      "check that the accounts, tokens, and tools an environment needs are in place; changes nothing",
    )
    .addOption(environmentOption())
    .action(async (options: { env: EnvironmentName }) => {
      const project = await loadProject();
      if (project) exitCode = await check(project.config, options.env, io);
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
    .command("promote")
    .description(
      "deploy the latest staging build that passed its smoke test, without rebuilding it",
    )
    .addOption(environmentOption())
    .option(
      "--build-id <id>",
      "promote this build, which must have passed on staging",
    )
    .option(
      "--choose",
      "print the build that would be promoted, and change nothing",
    )
    .option(
      "--confirm <id>",
      "refuse unless this is the build that would be promoted",
    )
    .action(
      async (options: {
        env: EnvironmentName;
        buildId?: string;
        choose?: boolean;
        confirm?: string;
      }) => {
        const project = await loadProject();
        if (project) {
          exitCode = await promote(
            project,
            options.env,
            {
              ...(options.buildId ? { buildId: options.buildId } : {}),
              ...(options.choose ? { choose: true } : {}),
              ...(options.confirm !== undefined
                ? { confirm: options.confirm }
                : {}),
            },
            io,
          );
        }
      },
    );

  const preview = program
    .command("preview")
    .description(
      "deploy or remove the preview environment of a pull request's branch",
    );
  preview
    .command("deploy")
    .description("apply, migrate, deploy, and smoke-test the branch's preview")
    .requiredOption("--branch <name>", "the pull request's branch")
    .addOption(buildIdOption())
    .action(async (options: { branch: string; buildId: string }) => {
      const project = await loadProject();
      if (project)
        exitCode = await deployPreview(
          project,
          options.branch,
          options.buildId,
          io,
        );
    });
  preview
    .command("remove")
    .description(
      "remove every resource of the branch's preview, and nothing else",
    )
    .requiredOption("--branch <name>", "the pull request's branch")
    .action(async (options: { branch: string }) => {
      const project = await loadProject();
      if (project) exitCode = await removePreview(project, options.branch, io);
    });

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
