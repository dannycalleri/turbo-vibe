import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectionUrl,
  type Endpoint,
  migratorRole,
  runtimeRole,
} from "../../src/database.js";
import type { Io } from "../../src/io.js";
import { migrateDatabase } from "../../src/migrate.js";
import { spawnCapturer, spawnRunner } from "../../src/run.js";
import { postgresSession } from "../../src/sql.js";

const admin = { role: "supabase_like_admin", password: "admin-pw" };
const passwords = {
  postgres_password: "postgres-pw",
  migrator_password: "migrator-pw",
  runtime_password: "runtime-pw",
  migrator_salt: "bWlncmF0b3Itc2FsdA==",
  runtime_salt: "cnVudGltZS1zYWx0LTE2",
};

let container = "";
let endpoint: Endpoint;

const io: Io = {
  cwd: process.cwd(),
  env: process.env,
  stdout: () => {},
  stderr: () => {},
  run: spawnRunner,
  capture: spawnCapturer,
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sql: postgresSession,
};

async function workdir(migrations: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-migrate-"));
  await mkdir(join(dir, "supabase", "migrations"), { recursive: true });
  for (const [name, sql] of Object.entries(migrations)) {
    await writeFile(join(dir, "supabase", "migrations", name), sql);
  }
  return dir;
}

async function as(role: string, password: string, statement: string) {
  const session = postgresSession(connectionUrl(endpoint, role, password));
  try {
    await session.execute(statement);
  } finally {
    await session.end();
  }
}

beforeAll(async () => {
  container = execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--rm",
      "-e",
      `POSTGRES_PASSWORD=${passwords.postgres_password}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:17.6",
    ],
    { encoding: "utf8" },
  ).trim();
  const port = Number(
    execFileSync("docker", ["port", container, "5432/tcp"], {
      encoding: "utf8",
    })
      .trim()
      .split(":")
      .at(-1),
  );
  endpoint = { host: "127.0.0.1", port, database: "postgres", ssl: false };
  for (let attempt = 0; ; attempt++) {
    try {
      await as("postgres", passwords.postgres_password, "select 1");
      break;
    } catch (error) {
      if (attempt > 60) throw error;
      await io.sleep(1000);
    }
  }
  // Supabase's postgres role is no superuser: it has CREATEROLE and owns the database.
  await as(
    "postgres",
    passwords.postgres_password,
    `CREATE ROLE ${admin.role} LOGIN CREATEROLE PASSWORD '${admin.password}'`,
  );
  await as(
    "postgres",
    passwords.postgres_password,
    `CREATE DATABASE app OWNER ${admin.role}`,
  );
  endpoint = { ...endpoint, database: "app" };
});

function migrateAsAdmin(dir: string) {
  return migrateDatabase(
    endpoint,
    { ...passwords, postgres_password: admin.password },
    dir,
    io,
    admin.role,
  );
}

afterAll(() => {
  if (container) execFileSync("docker", ["rm", "-f", container]);
});

describe("migrate against Postgres", () => {
  it("applies migrations as the migration role, and the runtime role can read but not change the schema", async () => {
    const dir = await workdir({
      "20261008000000_greeting.sql":
        "create table greeting (message text not null);\ninsert into greeting values ('hello from postgres');\n",
    });
    expect(await migrateAsAdmin(dir)).toBe(0);

    const runtime = (statement: string) =>
      as(runtimeRole, passwords.runtime_password, statement);
    await expect(
      runtime("select message from greeting"),
    ).resolves.toBeUndefined();
    await expect(
      runtime("alter table greeting add column extra int"),
    ).rejects.toThrow("must be owner of table greeting");
    await expect(runtime("create table intruder (id int)")).rejects.toThrow(
      "permission denied for schema public",
    );
    await expect(
      as(
        migratorRole,
        passwords.migrator_password,
        "alter table greeting add column extra int",
      ),
    ).resolves.toBeUndefined();
  });

  it("applies the example app's migration, whose row the runtime role can read", async () => {
    const example = new URL("../../examples/go-api", import.meta.url).pathname;
    const fresh = `example_${Date.now()}`;
    await as(
      "postgres",
      passwords.postgres_password,
      `CREATE DATABASE ${fresh} OWNER ${admin.role}`,
    );
    const original = endpoint;
    endpoint = { ...endpoint, database: fresh };
    try {
      expect(await migrateAsAdmin(example)).toBe(0);
      const session = postgresSession(
        connectionUrl(endpoint, runtimeRole, passwords.runtime_password),
      );
      try {
        await session.execute(
          "DO $$ BEGIN IF NOT EXISTS (SELECT FROM greeting WHERE id = 1 AND message = 'hello from postgres') THEN RAISE EXCEPTION 'greeting row missing'; END IF; END $$",
        );
      } finally {
        await session.end();
      }
    } finally {
      endpoint = original;
    }
  });

  it("is safe to run again with nothing new", async () => {
    const dir = await workdir({
      "20261008000000_greeting.sql":
        "create table greeting (message text not null);\n",
    });
    expect(await migrateAsAdmin(dir)).toBe(0);
  });

  it("fails on a broken migration and leaves the schema as it was", async () => {
    const dir = await workdir({
      "20261008000000_greeting.sql":
        "create table greeting (message text not null);\n",
      "20261009000000_broken.sql":
        "create table half_done (id int);\nselect no_such_function();\n",
    });
    expect(await migrateAsAdmin(dir)).not.toBe(0);
    await expect(
      as("postgres", passwords.postgres_password, "select * from half_done"),
    ).rejects.toThrow('relation "half_done" does not exist');
  });
});
