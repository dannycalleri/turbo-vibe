import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, EnvironmentName } from "./config/schema.js";
import { requiredSecrets, rootModule } from "./infrastructure.js";
import type { Io } from "./io.js";

export function missingVariables(names: Iterable<string>, io: Io): boolean {
  const missing = [...names].filter((name) => !io.env[name]).sort();
  if (missing.length === 0) return false;
  io.stderr(`missing environment variables: ${missing.join(", ")}\n`);
  return true;
}

async function initRoot(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<{ dir: string; code: number }> {
  const dir = join(io.cwd, ".turbo-vibe", "tofu", environment);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "main.tf.json"),
    `${JSON.stringify(rootModule(config, environment, io.env), null, 2)}\n`,
  );
  const code = await io.run("tofu", ["init", "-input=false"], {
    cwd: dir,
    env: io.env,
  });
  return { dir, code };
}

export async function apply(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<number> {
  if (missingVariables(requiredSecrets(config), io)) return 1;
  const { dir, code } = await initRoot(config, environment, io);
  if (code !== 0) return code;
  return io.run("tofu", ["apply", "-input=false", "-auto-approve"], {
    cwd: dir,
    env: io.env,
  });
}

export async function readOutputs(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<Record<string, unknown> | undefined> {
  const { dir, code } = await initRoot(config, environment, io);
  if (code !== 0) return undefined;
  const result = await io.capture("tofu", ["output", "-json"], {
    cwd: dir,
    env: io.env,
  });
  if (result.code !== 0) return undefined;
  const outputs = JSON.parse(result.stdout) as Record<
    string,
    { value: unknown }
  >;
  return Object.fromEntries(
    Object.entries(outputs).map(([name, output]) => [name, output.value]),
  );
}
