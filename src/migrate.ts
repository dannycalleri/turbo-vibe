import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { missingVariables, readOutputs } from "./apply.js";
import type { EnvironmentName } from "./config/schema.js";
import {
  type Connection,
  connectionUrl,
  type Endpoint,
  migratorRole,
  readiness,
  roleStatements,
  scramVerifier,
  sessionEndpoint,
} from "./database.js";
import type { Project } from "./deploy.js";
import { stateSecrets } from "./infrastructure.js";
import type { Io } from "./io.js";

const require = createRequire(import.meta.url);
const supabaseBin = join(
  dirname(require.resolve("supabase/package.json")),
  "dist",
  "supabase.js",
);

export async function migrateDatabase(
  endpoint: Endpoint,
  connection: Pick<
    Connection,
    | "postgres_password"
    | "migrator_password"
    | "runtime_password"
    | "migrator_salt"
    | "runtime_salt"
  >,
  workdir: string,
  io: Io,
  adminRole = "postgres",
): Promise<number> {
  const admin = io.sql(
    connectionUrl(endpoint, adminRole, connection.postgres_password),
  );
  try {
    for (const statement of roleStatements(endpoint.database, {
      migrator: scramVerifier(
        connection.migrator_password,
        Buffer.from(connection.migrator_salt, "base64"),
      ),
      runtime: scramVerifier(
        connection.runtime_password,
        Buffer.from(connection.runtime_salt, "base64"),
      ),
    })) {
      await admin.execute(statement);
    }
  } catch (error) {
    io.stderr(
      `role setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    await admin.end();
  }
  return io.run(
    process.execPath,
    [
      supabaseBin,
      "db",
      "push",
      "--include-all",
      "--workdir",
      workdir,
      "--db-url",
      connectionUrl(endpoint, migratorRole, connection.migrator_password),
    ],
    { cwd: workdir, env: io.env },
  );
}

export async function migrate(
  { config, configDir }: Project,
  environment: EnvironmentName,
  io: Io,
): Promise<number> {
  const databases = Object.entries(config.services).filter(
    ([, service]) => service.kind === "database",
  );
  if (databases.length === 0) {
    io.stdout("no database to migrate\n");
    return 0;
  }
  if (missingVariables([...stateSecrets, "SUPABASE_ACCESS_TOKEN"], io))
    return 1;

  const outputs = await readOutputs(config, environment, io);
  if (!outputs) {
    io.stderr(
      `cannot read ${environment} infrastructure outputs; run apply first\n`,
    );
    return 1;
  }

  for (const [name, service] of databases) {
    const connection = outputs[`supabase_${name}_connection`] as
      | Connection
      | undefined;
    if (!connection) {
      io.stderr(
        `no connection for database ${name} in ${environment}; run apply first\n`,
      );
      return 1;
    }
    const response = await io.fetch(
      `https://api.supabase.com/v1/projects/${connection.project_ref}`,
      { headers: { authorization: `Bearer ${io.env.SUPABASE_ACCESS_TOKEN}` } },
    );
    const status = response.ok
      ? ((await response.json()) as { status?: string }).status
      : `HTTP ${response.status}`;
    const ready = readiness(connection.project_ref, status);
    if (!ready.ok) {
      io.stderr(`${ready.message}\n`);
      return 1;
    }

    io.stdout(`migrate ${name} (${environment})\n`);
    const workdir = resolve(
      configDir,
      service.kind === "database" ? (service.workdir ?? ".") : ".",
    );
    const endpoint = sessionEndpoint(connection);
    if (!endpoint) {
      io.stderr(
        `Supabase project ${connection.project_ref} reports no pooler\n`,
      );
      return 1;
    }
    const code = await migrateDatabase(endpoint, connection, workdir, io);
    if (code !== 0) {
      io.stderr(
        `migrations for ${name} failed with exit code ${code}; nothing was deployed\n`,
      );
      return code;
    }
  }
  return 0;
}
