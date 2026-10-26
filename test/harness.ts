import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import type { Choice, Io, Prompts } from "../src/io.js";
import { main } from "../src/main.js";
import type { Runner } from "../src/run.js";

export async function run(
  argv: string[],
  files: Record<string, string> = {},
  env: Record<string, string> = {},
  runner: Runner = vi.fn(async () => 0),
  fetch: typeof globalThis.fetch = vi.fn(async () => new Response("unused")),
  overrides: Partial<Io> = {},
  nested: Record<string, string> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "turbo-vibe-"));
  for (const [name, content] of Object.entries({ ...files, ...nested })) {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), content);
  }
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env,
    run: runner,
    fetch,
    sleep: async () => {},
    capture: vi.fn(async () => ({ code: 0, stdout: "{}" })),
    sql: () => ({
      execute: async () => {},
      query: async () => [],
      end: async () => {},
    }),
    ...overrides,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, cwd };
}

export const project = `version: 1
project: acme
domain: acme.example.com
services:
  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile, test: "go test ./..." }
  web:
    kind: frontend
    target: cloudflare-static
    serve_with: api
    build: { command: "pnpm build", output: dist, test: "pnpm test" }
`;

export const stateEnv = {
  TURBO_VIBE_STATE_BUCKET: "tv-state",
  AWS_ACCESS_KEY_ID: "key-id",
  AWS_SECRET_ACCESS_KEY: "s3cr3t-key",
  CLOUDFLARE_ACCOUNT_ID: "acc123",
};

export function fakeR2(seed: Record<string, string> = {}) {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>(
    Object.entries(seed).map(([key, value]) => [
      key,
      new TextEncoder().encode(value),
    ]),
  );
  const unsigned: string[] = [];
  let rolloutReads = 0;
  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const named = url.searchParams.get("name");
    if (url.pathname.endsWith("/containers/applications") && named)
      return Response.json({ result: [{ id: `app-${named}`, name: named }] });
    if (url.pathname.endsWith("/rollouts")) {
      rolloutReads++;
      return Response.json({
        result: Array.from({ length: rolloutReads }, (_, index) => ({
          id: `rollout-${index}`,
          status: "completed",
          created_at: `2026-10-11T10:00:0${index}Z`,
        })),
      });
    }
    if (url.hostname !== "acc123.r2.cloudflarestorage.com") return undefined;
    if (
      !request.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 ")
    ) {
      unsigned.push(request.url);
    }
    const key = decodeURIComponent(url.pathname).replace(/^\/tv-state\/?/, "");
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter(
        (candidate) =>
          candidate.startsWith(prefix) &&
          !candidate.slice(prefix.length).includes("/"),
      );
      return new Response(
        `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
      );
    }
    if (request.method === "PUT") {
      objects.set(key, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    const body = objects.get(key);
    return body
      ? new Response(body)
      : new Response("NoSuchKey", { status: 404 });
  }
  return {
    objects,
    unsigned,
    record: (key: string) =>
      JSON.parse(new TextDecoder().decode(objects.get(key))),
    fetch(
      otherwise: (url: string, request: Request) => Response = () =>
        new Response("unused"),
    ) {
      return vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        return (await handle(request)) ?? otherwise(request.url, request);
      });
    },
  };
}

export const digest =
  "registry.cloudflare.com/acc123/acme-api@sha256:1111111111111111111111111111111111111111111111111111111111111111";

export function capturing(
  outputs: Record<string, unknown> = {},
  digests = [digest],
) {
  return vi.fn(async (command: string) =>
    command === "docker"
      ? { code: 0, stdout: JSON.stringify(digests) }
      : { code: 0, stdout: JSON.stringify(outputs) },
  );
}

export function runner(
  overrides: (
    command: string,
    args: readonly string[],
    options: Parameters<Runner>[2],
  ) => number | undefined | Promise<number | undefined> = () => undefined,
) {
  return vi.fn<Runner>(async (command, args, options) => {
    if (command === "tar" && args[0] === "-czf")
      await writeFile(args[1] as string, "archive");
    return (await overrides(command, args, options)) ?? 0;
  });
}

// Replies are keyed by the start of a prompt's message. A text reply may be a list, tried in
// order until one passes validation; undefined cancels; "" accepts the default.
export function fakePrompts(replies: Record<string, unknown>) {
  const asked: {
    message: string;
    options?: readonly Choice[];
    problems: string[];
  }[] = [];
  const reply = (message: string) =>
    replies[Object.keys(replies).find((key) => message.startsWith(key)) ?? ""];
  const prompts: Prompts = {
    async text(message, { initial, validate } = {}) {
      const record = { message, problems: [] as string[] };
      asked.push(record);
      const given = reply(message);
      for (const value of Array.isArray(given) ? given : [given]) {
        if (typeof value !== "string") return undefined;
        const answer = value === "" ? (initial ?? "") : value;
        const problem = validate?.(answer);
        if (!problem) return answer;
        record.problems.push(problem);
      }
      return undefined;
    },
    async select<T extends string>(
      message: string,
      options: readonly Choice<T>[],
      initial?: T,
    ) {
      asked.push({ message, options, problems: [] });
      const given = reply(message);
      return (given === "" ? initial : given) as T | undefined;
    },
    spinner(message) {
      const record = { message, problems: [] as string[] };
      asked.push(record);
      return {
        stop: (result: string, failed = false) => {
          if (failed) record.problems.push(result);
        },
      };
    },
    async confirm(message) {
      asked.push({ message, problems: [] });
      return reply(message) as boolean | undefined;
    },
    async multiselect<T extends string>(
      message: string,
      options: readonly Choice<T>[],
    ) {
      asked.push({ message, options, problems: [] });
      return reply(message) as T[] | undefined;
    },
  };
  return { prompts, asked };
}
