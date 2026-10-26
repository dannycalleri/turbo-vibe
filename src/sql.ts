import postgres from "postgres";

export interface SqlSession {
  execute(statement: string): Promise<void>;
  query(statement: string): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}

export function postgresSession(url: string): SqlSession {
  const warnings: string[] = [];
  const sql = postgres(url, {
    max: 1,
    onnotice: (notice) => {
      if (notice.severity === "WARNING") warnings.push(String(notice.message));
    },
  });
  return {
    async execute(statement) {
      warnings.length = 0;
      await sql.unsafe(statement);
      if (warnings.length > 0) throw new Error(warnings.join("; "));
    },
    async query(statement) {
      return [...(await sql.unsafe(statement))];
    },
    end: () => sql.end(),
  };
}
