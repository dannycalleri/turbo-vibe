import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseConfig } from "./config/load.js";
import type { Io } from "./io.js";

export const choices = {
  backend: ["cloudflare-container", "none"],
  frontend: ["cloudflare-static", "vercel-static", "vercel-nextjs", "none"],
  database: ["supabase", "none"],
  identity: ["workos", "none"],
} as const;

export interface Answers {
  name: string;
  domain: string;
  backend: (typeof choices.backend)[number];
  frontend: (typeof choices.frontend)[number];
  database: (typeof choices.database)[number];
  identity: (typeof choices.identity)[number];
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

permissions:
  contents: read

jobs:
  deploy:
    uses: dannycalleri/turbo-vibe/.github/workflows/deploy.yml@v1
    secrets: inherit
`;

export const productionWorkflow = `name: Deploy to production

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  promote:
    uses: dannycalleri/turbo-vibe/.github/workflows/promote.yml@v1
    secrets: inherit
`;

export function filesFor(answers: Answers): Record<string, string> {
  return {
    "turbo-vibe.yaml": configFor(answers),
    ".github/workflows/staging.yml": stagingWorkflow,
    ".github/workflows/production.yml": productionWorkflow,
  };
}

const questions: Record<keyof Answers, string> = {
  name: "Project name (lowercase letters, digits, hyphens)",
  domain: "Production domain, e.g. app.example.com",
  backend: `Backend target (${choices.backend.join(", ")})`,
  frontend: `Frontend target (${choices.frontend.join(", ")})`,
  database: `Database target (${choices.database.join(", ")})`,
  identity: `Identity target (${choices.identity.join(", ")})`,
};

export async function init(
  given: Partial<Record<keyof Answers, string>>,
  { force }: { force: boolean },
  io: Io,
): Promise<number> {
  const answers: Partial<Record<keyof Answers, string>> = { ...given };
  for (const key of Object.keys(questions) as (keyof Answers)[]) {
    if (answers[key]) continue;
    if (!io.ask) {
      io.stderr(
        `missing --${key}; run init in a terminal to be asked, or pass every option\n`,
      );
      return 1;
    }
    answers[key] = (await io.ask(questions[key])).trim();
  }
  for (const key of ["backend", "frontend", "database", "identity"] as const) {
    const allowed: readonly string[] = choices[key];
    if (!allowed.includes(answers[key] ?? "")) {
      io.stderr(`--${key} must be one of ${allowed.join(", ")}\n`);
      return 1;
    }
  }
  if (answers.backend === "none" && answers.frontend === "none") {
    io.stderr(
      "init needs a backend or a frontend: --backend and --frontend cannot both be none\n",
    );
    return 1;
  }
  const files = filesFor(answers as Answers);
  const parsed = parseConfig(files["turbo-vibe.yaml"] ?? "");
  if (!parsed.ok) {
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
  io.stdout(
    "next: add .turbo-vibe/ to .gitignore, then follow docs/bootstrap.md and run `turbo-vibe check --env staging`\n",
  );
  return 0;
}
