import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { adapters } from "./adapters/index.js";
import { type Assistant, assistantFiles, assistants } from "./assistant.js";
import { schemaUrl } from "./config/json-schema.js";
import { parseConfig } from "./config/load.js";
import type { Io } from "./io.js";
import { major, version } from "./version.js";

export const choices = {
  backend: ["cloudflare-container", "none"],
  frontend: ["cloudflare-static", "vercel-static", "vercel-nextjs", "none"],
  database: ["supabase", "none"],
  identity: ["workos", "none"],
  assistant: assistants,
} as const;

export interface Answers {
  name: string;
  domain: string;
  backend: (typeof choices.backend)[number];
  frontend: (typeof choices.frontend)[number];
  database: (typeof choices.database)[number];
  identity: (typeof choices.identity)[number];
  assistant: (typeof choices.assistant)[number];
}

function sibling(prefix: string, hostname: string, apex: boolean): string {
  if (apex) return `${prefix}.${hostname}`;
  const [first, ...rest] = hostname.split(".");
  return `${prefix}-${first}.${rest.join(".")}`;
}

export function configFor(answers: Answers): string {
  const apex = answers.domain.split(".").length === 2;
  const staging = sibling("staging", answers.domain, apex);
  const crossOrigin =
    answers.backend !== "none" && answers.frontend.startsWith("vercel-");
  const lines = [
    `# yaml-language-server: $schema=${schemaUrl(major)}`,
    "version: 1",
    `project: ${answers.name}`,
    `domain: ${answers.domain}`,
    "# Every hostname stays one level below the zone, which Cloudflare's free certificate covers.",
    "environments:",
    `  staging:`,
    `    hostname: ${staging}`,
    ...(crossOrigin
      ? [`    api_hostname: ${sibling("api", staging, false)}`]
      : []),
    ...(crossOrigin
      ? [
          "  production:",
          `    api_hostname: ${sibling("api", answers.domain, apex)}`,
        ]
      : []),
    "services:",
  ];
  if (answers.backend !== "none") {
    lines.push(
      "  api:",
      "    kind: backend",
      `    target: ${answers.backend}`,
      "    build:",
      "      dockerfile: Dockerfile",
      "      # test: make test",
    );
  }
  if (answers.frontend === "vercel-nextjs") {
    lines.push(
      "  web:",
      "    kind: frontend",
      "    target: vercel-nextjs",
      "    build:",
      "      command: npm ci",
    );
  } else if (answers.frontend !== "none") {
    lines.push(
      "  web:",
      "    kind: frontend",
      `    target: ${answers.frontend}`,
      ...(answers.frontend === "cloudflare-static" && answers.backend !== "none"
        ? ["    serve_with: api"]
        : []),
      "    build:",
      "      command: npm ci && npm run build   # a default: your build command",
      "      output: dist   # a default: your build's output directory",
    );
  }
  if (answers.database !== "none") {
    lines.push(
      "  db:",
      "    kind: database",
      "    target: supabase",
      "    organization: your-supabase-org-slug   # Organization Settings → Organization slug",
      "    region: us-east-1   # a default: your Supabase region",
      "    plan: free",
    );
  }
  if (answers.identity !== "none") {
    lines.push("  auth:", "    kind: identity", "    target: workos");
  }
  return `${lines.join("\n")}\n`;
}

export const stagingWorkflow = `name: Staging

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
    inputs:
      allow-deletions:
        description: Let apply delete or replace resources
        type: boolean
        default: false

permissions:
  contents: read

jobs:
  deploy:
    uses: dannycalleri/turbo-vibe/.github/workflows/deploy.yml@v1
    with:
      allow-deletions: \${{ inputs.allow-deletions == true }}
    secrets: inherit
`;

export const productionWorkflow = `name: Deploy to production

on:
  workflow_dispatch:
    inputs:
      confirm-build:
        description: The ID of the build to promote, as the last Staging run reports it
        type: string
        required: true
      allow-deletions:
        description: Let apply delete or replace resources
        type: boolean
        default: false

permissions:
  contents: read

jobs:
  promote:
    uses: dannycalleri/turbo-vibe/.github/workflows/promote.yml@v1
    with:
      confirm-build: \${{ inputs.confirm-build }}
      allow-deletions: \${{ inputs.allow-deletions == true }}
    secrets: inherit
`;

export function filesFor(answers: Answers): Record<string, string> {
  return {
    "turbo-vibe.yaml": configFor(answers),
    ".github/workflows/staging.yml": stagingWorkflow,
    ".github/workflows/production.yml": productionWorkflow,
    ...assistantFiles(answers.assistant, version),
  };
}

export const labelled = (targets: readonly string[]) =>
  targets
    .map((target) =>
      adapters[target]?.stability === "beta" ? `${target} (beta)` : target,
    )
    .join(", ");

const questions: Record<keyof Answers, string> = {
  name: "Project name (lowercase letters, digits, hyphens)",
  domain: "Production domain, e.g. app.example.com",
  backend: `Backend target (${labelled(choices.backend)})`,
  frontend: `Frontend target (${labelled(choices.frontend)})`,
  database: `Database target (${labelled(choices.database)})`,
  identity: `Identity target (${labelled(choices.identity)})`,
  assistant: `Coding assistant guidance to write (${choices.assistant.join(", ")})`,
};

export async function init(
  given: Partial<Record<keyof Answers, string>>,
  { force, onlyAssistant = false }: { force: boolean; onlyAssistant?: boolean },
  io: Io,
): Promise<number> {
  const answers: Partial<Record<keyof Answers, string>> = { ...given };
  const asked: (keyof Answers)[] = onlyAssistant
    ? ["assistant"]
    : (Object.keys(questions) as (keyof Answers)[]);
  for (const key of asked) {
    if (answers[key]) continue;
    if (!io.ask) {
      io.stderr(
        `missing --${key}; run init in a terminal to be asked, or pass every option\n`,
      );
      return 1;
    }
    answers[key] = (await io.ask(questions[key])).trim();
  }
  for (const key of (
    ["backend", "frontend", "database", "identity", "assistant"] as const
  ).filter((key) => asked.includes(key))) {
    const allowed: readonly string[] = choices[key];
    if (!allowed.includes(answers[key] ?? "")) {
      io.stderr(`--${key} must be one of ${allowed.join(", ")}\n`);
      return 1;
    }
  }
  if (onlyAssistant && answers.assistant === "none") {
    io.stderr("--only-assistant needs --assistant claude, cursor or both\n");
    return 1;
  }
  if (
    !onlyAssistant &&
    answers.backend === "none" &&
    answers.frontend === "none"
  ) {
    io.stderr(
      "init needs a backend or a frontend: --backend and --frontend cannot both be none\n",
    );
    return 1;
  }
  const files = onlyAssistant
    ? assistantFiles(answers.assistant as Assistant, version)
    : filesFor(answers as Answers);
  const config = files["turbo-vibe.yaml"];
  const parsed = config === undefined ? undefined : parseConfig(config);
  if (parsed && !parsed.ok) {
    for (const { message } of parsed.problems) io.stderr(`${message}\n`);
    return 1;
  }
  if (!force) {
    const existing: string[] = [];
    for (const name of Object.keys(files)) {
      if (
        await access(join(io.cwd, name)).then(
          () => true,
          () => false,
        )
      )
        existing.push(name);
    }
    if (existing.length > 0) {
      io.stderr(
        `${existing.join(", ")} already exist${existing.length === 1 ? "s" : ""}; nothing was written (pass --force to replace)\n`,
      );
      return 1;
    }
  }
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(io.cwd, name)), { recursive: true });
    await writeFile(join(io.cwd, name), content);
    io.stdout(`wrote ${name}\n`);
  }
  if (!onlyAssistant) {
    io.stdout(
      "next: add .turbo-vibe/ to .gitignore, create the accounts in docs/bootstrap.md, then run `turbo-vibe setup` in a terminal\n",
    );
  }
  return 0;
}
