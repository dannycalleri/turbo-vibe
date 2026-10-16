import type { Capturer, Runner } from "./run.js";
import type { SqlSession } from "./sql.js";

export interface Choice<T extends string = string> {
  value: T;
  label?: string;
  hint?: string;
}

// Each prompt resolves to undefined when the person cancels it.
export interface Prompts {
  text: (
    message: string,
    options?: {
      initial?: string;
      validate?: (value: string) => string | undefined;
    },
  ) => Promise<string | undefined>;
  select: <T extends string>(
    message: string,
    options: readonly Choice<T>[],
    initial?: T,
  ) => Promise<T | undefined>;
  multiselect: <T extends string>(
    message: string,
    options: readonly Choice<T>[],
    { initial, required }: { initial?: readonly T[]; required: boolean },
  ) => Promise<T[] | undefined>;
}

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
  prompts?: Prompts;
}
