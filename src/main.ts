import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command, CommanderError, Option } from "commander";
import { apply, plan } from "./apply.js";
import { assistantNames } from "./assistant.js";
import { check } from "./check.js";
import {
  compatibility,
  exampleTargets,
  type Run,
  readPins,
  runSchema,
} from "./compatibility.js";
import { jsonSchema } from "./config/json-schema.js";
import { loadConfigFile } from "./config/load.js";
import { type EnvironmentName, environmentNames } from "./config/schema.js";
import { deploy, type Project, promote, smoke, test } from "./deploy.js";
import {
  type AssistantOption,
  adopt,
  choices,
  init,
  labelled,
} from "./init.js";
import type { Io } from "./io.js";
import { migrate } from "./migrate.js";
import { derivePlan, formatPlan } from "./plan.js";
import { backendPorts } from "./port.js";
import { deployPreview, removePreview } from "./preview.js";
import { setupSteps } from "./setup/list.js";
import { defaultEnvironments, setup } from "./setup.js";
import { major, version } from "./version.js";

export type { Io } from "./io.js";

const assistantFlag = "--assistant <names>";
const assistantHelp = `coding assistants to write guidance for: ${assistantNames.join(", ")}, as a comma-separated list or a repeated flag (default: the ones this repository already uses)`;
const noAssistantFlag = "--no-assistant";
const noAssistantHelp = "write no coding assistant guidance";
const collect = (value: string, previous: unknown) => [
  ...(Array.isArray(previous) ? previous : []),
  value,
];

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
        const ports = await backendPorts(project.config, project.configDir);
        io.stdout(`${formatPlan(derivePlan(project.config, ports))}\n`);
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
    .command("compatibility", { hidden: true })
    .description(
      "regenerate COMPATIBILITY.md from the pinned versions and, with --results, a live run's outcomes",
    )
    .option("--results <file>", "a live run's outcomes, as JSON")
    .option("--matrix <file>", "the matrix to update", "COMPATIBILITY.md")
    .action(async (options: { results?: string; matrix: string }) => {
      const matrix = resolve(io.cwd, options.matrix);
      const previous = await readFile(matrix, "utf8").catch(() => undefined);
      let run: Run | undefined;
      if (options.results) {
        const parsed = runSchema.safeParse(
          JSON.parse(await readFile(resolve(io.cwd, options.results), "utf8")),
        );
        if (!parsed.success) {
          io.stderr(
            `${options.results}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}\n`,
          );
          exitCode = 1;
          return;
        }
        run = parsed.data;
      }
      await writeFile(
        matrix,
        compatibility({
          ...(previous === undefined ? {} : { previous }),
          ...(run ? { run } : {}),
          examples: await exampleTargets(io.cwd),
          pins: await readPins(io.cwd),
        }),
      );
      io.stdout(`wrote ${options.matrix}\n`);
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
    .option(assistantFlag, assistantHelp, collect)
    .option(noAssistantFlag, noAssistantHelp)
    .option(
      "--only-assistant",
      "write only the coding assistant guidance, for a project that already has turbo-vibe.yaml",
    )
    .option("--force", "replace files that already exist")
    .action(
      async (
        options: Record<string, string | boolean | string[] | undefined>,
      ) => {
        const { force, onlyAssistant, assistant, ...given } = options;
        exitCode = await init(
          given as Record<string, string>,
          {
            force: force === true,
            onlyAssistant: onlyAssistant === true,
            assistant: assistant as AssistantOption,
          },
          io,
        );
      },
    );

  program
    .command("adopt")
    .description(
      "write the coding assistant guidance that adapts an existing project to turbo-vibe",
    )
    .option(assistantFlag, assistantHelp, collect)
    .option(noAssistantFlag, noAssistantHelp)
    .option("--force", "replace files that already exist")
    .action(
      async (options: { assistant?: AssistantOption; force?: boolean }) => {
        exitCode = await adopt(
          options.assistant,
          { force: options.force === true },
          io,
        );
      },
    );

  program
    .command("check")
    .description(
      "check that the accounts, tokens, and tools an environment needs are in place; changes nothing",
    )
    .addOption(environmentOption())
    .action(async (options: { env: EnvironmentName }) => {
      const project = await loadProject();
      if (project)
        exitCode = await check(project.config, options.env, io, {
          configDir: project.configDir,
        });
    });

  program
    .command("setup")
    .description(
      "create the GitHub environments, with a required reviewer on production, and store each missing secret, creating the Cloudflare ones from one bootstrap token",
    )
    .option(
      "-e, --env <environment...>",
      "GitHub environments to set up (default: staging and production, plus preview when the config enables previews); any name other than production is set up like staging",
    )
    .option("--repo <owner/name>", "GitHub repository (default: this one)")
    .option(
      "--replace <secret...>",
      "ask for these secrets again, and create their Cloudflare tokens again",
    )
    .option(
      "--list",
      "print the accounts, plans and steps a person must do, and the secrets setup stores; changes nothing",
    )
    .action(
      async (options: {
        env?: string[];
        repo?: string;
        replace?: string[];
        list?: boolean;
      }) => {
        const project = await loadProject();
        if (!project) return;
        const env = options.env ?? defaultEnvironments(project.config);
        if (options.list) io.stdout(setupSteps(project.config, env));
        else
          exitCode = await setup(
            project.config,
            { ...options, env, configDir: project.configDir },
            io,
          );
      },
    );

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
