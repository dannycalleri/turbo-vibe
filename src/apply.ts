import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, EnvironmentName } from "./config/schema.js";
import { requiredSecrets, rootModule } from "./infrastructure.js";
import type { Io } from "./io.js";

export async function apply(
  config: Config,
  environment: EnvironmentName,
  io: Io,
): Promise<number> {
  const missing = requiredSecrets(config).filter((name) => !io.env[name]);
  if (missing.length > 0) {
    io.stderr(`missing environment variables: ${missing.join(", ")}\n`);
    return 1;
  }

  const dir = join(io.cwd, ".turbo-vibe", "tofu", environment);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "main.tf.json"),
    `${JSON.stringify(rootModule(config, environment, io.env), null, 2)}\n`,
  );

  for (const args of [
    ["init", "-input=false"],
    ["apply", "-input=false", "-auto-approve"],
  ]) {
    const code = await io.run("tofu", args, { cwd: dir, env: io.env });
    if (code !== 0) return code;
  }
  return 0;
}
