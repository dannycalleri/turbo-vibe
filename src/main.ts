import { resolve } from "node:path";
import { Command, CommanderError, Option } from "commander";
import { apply } from "./apply.js";
import { loadConfigFile } from "./config/load.js";
import {
  type Config,
  type EnvironmentName,
  environmentNames,
} from "./config/schema.js";
import { derivePlan, formatPlan } from "./plan.js";
import type { Runner } from "./run.js";

export interface Io {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  run: Runner;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  let exitCode = 0;
  const program = new Command("turbo-vibe")
    .description("Deploy a project's services from turbo-vibe.yaml.")
    .option("-c, --config <file>", "project config file", "turbo-vibe.yaml")
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  async function loadConfig(): Promise<Config | undefined> {
    const file = resolve(io.cwd, program.opts<{ config: string }>().config);
    const result = await loadConfigFile(file);
    if (result.ok) return result.config;
    for (const { line, message } of result.problems) {
      io.stderr(
        line > 0 ? `${file}:${line}: ${message}\n` : `${file}: ${message}\n`,
      );
    }
    exitCode = 1;
    return undefined;
  }

  const environmentOption = new Option(
    "-e, --env <environment>",
    "environment to act on",
  )
    .choices(environmentNames)
    .makeOptionMandatory();

  program
    .command("plan")
    .description(
      "show the services each environment would run, without changing anything",
    )
    .action(async () => {
      const config = await loadConfig();
      if (config) io.stdout(`${formatPlan(derivePlan(config))}\n`);
    });

  program
    .command("apply")
    .description(
      "create or update an environment's infrastructure with OpenTofu",
    )
    .addOption(environmentOption)
    .action(async (options: { env: EnvironmentName }) => {
      const config = await loadConfig();
      if (config) exitCode = await apply(config, options.env, io);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  return exitCode;
}
