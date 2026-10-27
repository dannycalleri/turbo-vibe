import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { missingVariables, readOutputs } from "./apply.js";
import type { EnvironmentName } from "./config/schema.js";
import { stateSecrets } from "./contract.js";
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
import type { Io } from "./io.js";
import type { SqlSession } from "./sql.js";

const require = createRequire(import.meta.url);
const supabaseBin = join(
  dirname(require.resolve("supabase/package.json")),
  "dist",
  "supabase.js",
);

async function appliedVersions(session: SqlSession): Promise<string[]> {
  const [table] = await session.query(
    "select to_regclass('supabase_migrations.schema_migrations') is not null as present",
  );
  if (!table?.present) return [];
  const rows = await session.query(
    "select version from supabase_migrations.schema_migrations",
  );
  return rows.map((row) => String(row.version));
}

async function localVersions(workdir: string): Promise<Set<string>> {
  const files = await readdir(join(workdir, "supabase", "migrations")).catch(
    () => [] as string[],
  );
  return new Set(
    files.flatMap((file) => /^(\d+)_.*\.sql$/.exec(file)?.[1] ?? []),
  );
}

const crossedMessage = (missing: readonly string[]) =>
  `the database has ${missing.length > 1 ? "migrations" : "migration"} ${missing.join(", ")}, which this commit lacks: a rollback cannot cross a migration, so promote a newer build that fixes forward`;

async function crossedMigrations(
  endpoint: Endpoint,
  connection: Pick<Connection, "migrator_password">,
  workdir: string,
  io: Io,
): Promise<string[] | string | undefined> {
  const migrator = io.sql(
    connectionUrl(endpoint, migratorRole, connection.migrator_password),
  );
  let applied: string[];
  try {
    applied = await appliedVersions(migrator);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await migrator.end();
  }
  const local = await localVersions(workdir);
  const missing = applied.filter((version) => !local.has(version)).sort();
  return missing.length > 0 ? missing : undefined;
}

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
  const crossed = await crossedMigrations(endpoint, connection, workdir, io);
  if (typeof crossed === "string")
    io.stdout(
      `warn  cannot read the applied migrations (${crossed}); supabase db push compares them itself\n`,
    );
  else if (crossed !== undefined) {
    io.stderr(`${crossedMessage(crossed)}. Nothing was migrated\n`);
    return 1;
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
  { check = false }: { check?: boolean } = {},
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
      if (check) {
        io.stdout(
          `database ${name} does not exist in ${environment} yet; no migration to check\n`,
        );
        continue;
      }
      io.stderr(
        `no connection for database ${name} in ${environment}; run apply first\n`,
      );
      return 1;
    }
    let response: Response;
    try {
      response = await io.fetch(
        `https://api.supabase.com/v1/projects/${connection.project_ref}`,
        {
          headers: { authorization: `Bearer ${io.env.SUPABASE_ACCESS_TOKEN}` },
        },
      );
    } catch (error) {
      io.stderr(
        `cannot reach the Supabase API (${error instanceof Error ? error.message : String(error)}); nothing was migrated, rerun\n`,
      );
      return 1;
    }
    const status = response.ok
      ? ((await response.json()) as { status?: string }).status
      : `HTTP ${response.status}`;
    const ready = readiness(connection.project_ref, status);
    if (!ready.ok) {
      io.stderr(`${ready.message}\n`);
      return 1;
    }

    if (!check) io.stdout(`migrate ${name} (${environment})\n`);
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
    if (check) {
      const crossed = await crossedMigrations(
        endpoint,
        connection,
        workdir,
        io,
      );
      if (Array.isArray(crossed)) {
        io.stderr(`${crossedMessage(crossed)}. ${environment} is unchanged\n`);
        return 1;
      }
      io.stdout(
        crossed === undefined
          ? `database ${name}: this commit has every migration ${environment} has applied\n`
          : `warn  database ${name}: cannot read the applied migrations (${crossed}); migrate checks again after apply\n`,
      );
      continue;
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
