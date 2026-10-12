import type { Capturer, Runner } from "./run.js";
import type { SqlSession } from "./sql.js";

export interface Io {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  run: Runner;
  capture: Capturer;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  sql: (url: string) => SqlSession;
  ask?: (question: string) => Promise<string>;
  askSecret?: (question: string) => Promise<string>;
}
