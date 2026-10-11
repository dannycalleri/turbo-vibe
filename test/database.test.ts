import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  connectionUrl,
  type Endpoint,
  readiness,
  roleStatements,
  runtimeUrl,
  scramVerifier,
  sessionEndpoint,
  transactionPoolerProblem,
} from "../src/database.js";

const connection = {
  project_ref: "abcdefghij",
  pooler_urls: {
    transaction:
      "postgresql://postgres.abcdefghij:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
  },
  postgres_password: "p",
  migrator_password: "m",
  runtime_password: "r",
  migrator_salt: "bXNhbHQ=",
  runtime_salt: "cnNhbHQ=",
};

const session: Endpoint = {
  host: "aws-0-eu-central-1.pooler.supabase.com",
  port: 5432,
  database: "postgres",
  projectRef: "abcdefghij",
  ssl: true,
};

describe("sessionEndpoint", () => {
  it("derives the session pooler on 5432 from the transaction pooler the API lists", () => {
    expect(sessionEndpoint(connection)).toEqual(session);
  });

  it("keeps a session-mode URL the API lists", () => {
    expect(
      sessionEndpoint({
        ...connection,
        pooler_urls: {
          session:
            "postgresql://postgres.abcdefghij:x@other.pooler.supabase.com:5432/app",
        },
      }),
    ).toEqual({
      ...session,
      host: "other.pooler.supabase.com",
      database: "app",
    });
  });

  it("returns nothing when the project reports no pooler", () => {
    expect(sessionEndpoint({ ...connection, pooler_urls: {} })).toBeUndefined();
  });
});

describe("connectionUrl", () => {
  it("addresses a role through the pooler as role.ref and encodes the password", () => {
    expect(connectionUrl(session, "turbo_vibe_runtime", "p@ss/word")).toBe(
      "postgresql://turbo_vibe_runtime.abcdefghij:p%40ss%2Fword@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require",
    );
  });

  it("uses the bare role name without a project ref", () => {
    expect(
      connectionUrl(
        { host: "localhost", port: 5433, database: "app", ssl: false },
        "turbo_vibe_migrator",
        "m",
      ),
    ).toBe(
      "postgresql://turbo_vibe_migrator:m@localhost:5433/app?sslmode=disable",
    );
  });
});

describe("roleStatements", () => {
  it("creates both roles idempotently and lets only the migration role create objects", () => {
    const statements = roleStatements("postgres", {
      migrator: "m'1",
      runtime: "r",
    });
    expect(statements).toContain(
      "ALTER ROLE turbo_vibe_migrator WITH LOGIN PASSWORD 'm''1'",
    );
    expect(statements).toContain(
      'GRANT CREATE ON DATABASE "postgres" TO turbo_vibe_migrator',
    );
    expect(statements).toContain(
      "GRANT USAGE ON SCHEMA public TO turbo_vibe_runtime",
    );
    expect(
      statements.filter(
        (statement) =>
          statement.includes("CREATE ON") &&
          statement.includes("turbo_vibe_runtime"),
      ),
    ).toEqual([]);
  });
});

describe("readiness", () => {
  it("accepts a healthy project", () => {
    expect(readiness("abc", "ACTIVE_HEALTHY")).toEqual({ ok: true });
  });

  it.each(["INACTIVE", "PAUSING", "PAUSE_FAILED"])(
    "reports %s as paused",
    (status) => {
      expect(readiness("abc", status)).toEqual({
        ok: false,
        message:
          "Supabase project abc is paused; restore it in the Supabase dashboard, then rerun",
      });
    },
  );

  it("reports any other status as not ready", () => {
    expect(readiness("abc", "COMING_UP")).toEqual({
      ok: false,
      message: "Supabase project abc is not ready (status COMING_UP)",
    });
  });
});

describe("scramVerifier", () => {
  it("builds the SCRAM-SHA-256 verifier Postgres stores, so the plaintext never reaches the server", () => {
    const salt = Buffer.from("0123456789abcdef");
    const salted = pbkdf2Sync("secret", salt, 4096, 32, "sha256");
    const storedKey = createHash("sha256")
      .update(createHmac("sha256", salted).update("Client Key").digest())
      .digest("base64");
    const serverKey = createHmac("sha256", salted)
      .update("Server Key")
      .digest("base64");
    expect(scramVerifier("secret", salt)).toBe(
      `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`,
    );
  });
});

describe("runtime connection", () => {
  it("connects the runtime role through the session pooler", () => {
    expect(runtimeUrl(connection)).toBe(
      "postgresql://turbo_vibe_runtime.abcdefghij:r@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require",
    );
  });

  it.each([
    "postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
    "postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?pgbouncer=true",
  ])("rejects a transaction-pooler URL: %s", (url) => {
    expect(transactionPoolerProblem(url)).toBe(
      "the runtime connection to aws-0-eu-central-1.pooler.supabase.com uses the transaction pooler; backends must use the session pooler (port 5432)",
    );
  });

  it("accepts a session-pooler URL", () => {
    expect(
      transactionPoolerProblem(runtimeUrl(connection) as string),
    ).toBeUndefined();
  });
});
