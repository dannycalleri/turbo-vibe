import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { loadConfigFile } from "./config/load.js";
import { derivePlan, formatPlan } from "./plan.js";

export interface Io {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  let exitCode = 0;
  const program = new Command("turbo-vibe")
    .description("Deploy a project's services from turbo-vibe.yaml.")
    .option("-c, --config <file>", "project config file", "turbo-vibe.yaml")
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command("plan")
    .description(
      "show the services each environment would run, without changing anything",
    )
    .action(async () => {
      const file = resolve(io.cwd, program.opts<{ config: string }>().config);
      const result = await loadConfigFile(file);
      if (!result.ok) {
        for (const { line, message } of result.problems) {
          io.stderr(
            line > 0
              ? `${file}:${line}: ${message}\n`
              : `${file}: ${message}\n`,
          );
        }
        exitCode = 1;
        return;
      }
      io.stdout(`${formatPlan(derivePlan(result.config))}\n`);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  return exitCode;
}
