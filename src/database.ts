import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

export const migratorRole = "turbo_vibe_migrator";
export const runtimeRole = "turbo_vibe_runtime";

export interface Endpoint {
  host: string;
  port: number;
  database: string;
  projectRef?: string;
  ssl: boolean;
}

export interface Connection {
  project_ref: string;
  pooler_urls: Record<string, string>;
  postgres_password: string;
  migrator_password: string;
  runtime_password: string;
}

const sessionPort = 5432;

// The pooler API lists only the project's primary pool mode, usually transaction on 6543;
// session mode is the same Supavisor host on 5432.
export function sessionEndpoint(connection: Connection): Endpoint | undefined {
  const urls = Object.values(connection.pooler_urls).map((raw) => new URL(raw));
  const url =
    urls.find((candidate) => Number(candidate.port) === sessionPort) ?? urls[0];
  if (!url) return undefined;
  return {
    host: url.hostname,
    port: sessionPort,
    database: url.pathname.slice(1) || "postgres",
    projectRef: connection.project_ref,
    ssl: true,
  };
}

export function connectionUrl(
  endpoint: Endpoint,
  role: string,
  password: string,
): string {
  const user = endpoint.projectRef ? `${role}.${endpoint.projectRef}` : role;
  const url = new URL(
    `postgresql://${endpoint.host}:${endpoint.port}/${endpoint.database}`,
  );
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  url.searchParams.set("sslmode", endpoint.ssl ? "require" : "disable");
  return url.toString();
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function ident(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function scramVerifier(
  password: string,
  salt: Buffer,
  iterations = 4096,
): string {
  const salted = pbkdf2Sync(
    password.normalize("NFKC"),
    salt,
    iterations,
    32,
    "sha256",
  );
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export function roleStatements(
  database: string,
  verifiers: { migrator: string; runtime: string },
): string[] {
  const statements: string[] = [];
  for (const [role, verifier] of [
    [migratorRole, verifiers.migrator],
    [runtimeRole, verifiers.runtime],
  ] as const) {
    statements.push(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(role)}) THEN CREATE ROLE ${role} LOGIN; END IF; END $$`,
      `ALTER ROLE ${role} WITH LOGIN PASSWORD ${literal(verifier)}`,
    );
  }
  return [
    ...statements,
    `GRANT ${migratorRole} TO CURRENT_USER`,
    // The Supabase CLI runs CREATE SCHEMA IF NOT EXISTS for its history table, which needs CREATE on the database.
    `GRANT CREATE ON DATABASE ${ident(database)} TO ${migratorRole}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${migratorRole}`,
    `GRANT USAGE ON SCHEMA public TO ${runtimeRole}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeRole}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${runtimeRole}`,
  ];
}

const pausedStatuses = new Set(["INACTIVE", "PAUSING", "PAUSE_FAILED"]);

export function readiness(
  ref: string,
  status: string | undefined,
): { ok: true } | { ok: false; message: string } {
  if (status === "ACTIVE_HEALTHY") return { ok: true };
  if (status && pausedStatuses.has(status)) {
    return {
      ok: false,
      message: `Supabase project ${ref} is paused; restore it in the Supabase dashboard, then rerun`,
    };
  }
  return {
    ok: false,
    message: `Supabase project ${ref} is not ready (status ${status ?? "unknown"})`,
  };
}
