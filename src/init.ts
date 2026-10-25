import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { adapters } from "./adapters/index.js";
import {
  type AssistantName,
  adoptionFiles,
  assistantFiles,
  assistantNames,
  detectAssistants,
  parseAssistants,
} from "./assistant.js";
import { schemaUrl } from "./config/json-schema.js";
import { parseConfig } from "./config/load.js";
import { hostname, name } from "./config/schema.js";
import { type Defaults, detectProject, readRepository } from "./detect.js";
import type { Choice, Io } from "./io.js";
import { defaultEnvironments, githubSignedIn, setup } from "./setup.js";
import { cliRange, version, workflowRef } from "./version.js";

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
  assistant: readonly AssistantName[];
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
    `# yaml-language-server: $schema=${schemaUrl(cliRange)}`,
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
      "    # organization: your-org-slug   # or leave it out: setup finds it and stores it as SUPABASE_ORGANIZATION",
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
    uses: dannycalleri/turbo-vibe/.github/workflows/deploy.yml@${workflowRef}
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
    uses: dannycalleri/turbo-vibe/.github/workflows/promote.yml@${workflowRef}
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

// `false` is --no-assistant; undefined means the flag was not given.
export type AssistantOption = readonly string[] | false | undefined;

const assistantLabels: Record<AssistantName, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
};

async function resolveAssistants(
  option: AssistantOption,
  io: Io,
  required = false,
): Promise<AssistantName[] | string> {
  if (option === false) return [];
  if (option) {
    const parsed = parseAssistants(option);
    return typeof parsed === "string" ? `--assistant: ${parsed}` : parsed;
  }
  const detected = await detectAssistants(io.cwd);
  if (detected.length > 0) {
    io.stdout(
      `writing guidance for ${detected.join(", ")}, found in this repository\n`,
    );
    return detected;
  }
  if (!io.prompts) return [];
  const chosen = await io.prompts.multiselect(
    "Coding assistants to write guidance for",
    assistantNames.map((value) => ({ value, label: assistantLabels[value] })),
    { required },
  );
  return chosen ?? cancelled;
}

const cancelled = "cancelled; nothing was written";

type Question = Exclude<keyof Answers, "assistant">;
type Target = Exclude<Question, "name" | "domain">;

const textQuestions = {
  name: { message: "Project name", field: name },
  domain: {
    message: "Production domain, such as app.example.com",
    field: hostname,
  },
} as const;

const targetQuestions: Record<Target, string> = {
  backend: "Backend",
  frontend: "Frontend",
  database: "Database",
  identity: "Sign-in",
};

const targetHints: Record<string, string> = {
  "cloudflare-container": "your Dockerfile on Cloudflare Containers",
  "cloudflare-static":
    "static site on Cloudflare Workers, the successor to Pages",
  "vercel-static": "static site on Vercel",
  "vercel-nextjs": "Next.js on Vercel",
  supabase: "Postgres on Supabase, a project per environment",
  workos: "WorkOS AuthKit, sign-in per environment",
};

const targetChoices = (
  key: Target,
  answers: Partial<Record<Question, string>>,
) =>
  choices[key]
    .filter(
      (target) =>
        !(
          target === "none" &&
          ((key === "frontend" && answers.backend === "none") ||
            (key === "backend" && answers.frontend === "none"))
        ),
    )
    .map(
      (target): Choice => ({
        value: target,
        label: labelled([target]),
        hint: targetHints[target] ?? `no ${targetQuestions[key].toLowerCase()}`,
      }),
    );

const problemWith = (
  field: typeof name | typeof hostname,
  value: string,
): string | undefined => {
  const parsed = field.safeParse(value);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
};

async function askFor(
  key: Question,
  answers: Partial<Record<Question, string>>,
  defaults: Defaults,
  io: Io,
): Promise<string | undefined> {
  const prompts = io.prompts as NonNullable<Io["prompts"]>;
  if (key === "name" || key === "domain") {
    const { message, field } = textQuestions[key];
    const initial = defaults[key];
    const answer = await prompts.text(message, {
      ...(initial ? { initial } : {}),
      validate: (value) => problemWith(field, value.trim()),
    });
    return answer?.trim();
  }
  const options = targetChoices(key, answers);
  const detected = options.find(({ value }) => value === defaults[key]);
  return prompts.select(
    targetQuestions[key],
    options,
    (detected ?? options[0])?.value,
  );
}

export async function init(
  given: Partial<Record<Exclude<keyof Answers, "assistant">, string>>,
  {
    force,
    onlyAssistant = false,
    assistant: option,
  }: { force: boolean; onlyAssistant?: boolean; assistant?: AssistantOption },
  io: Io,
): Promise<number> {
  const answers: Partial<Record<Question, string>> = { ...given };
  const asked: Question[] = onlyAssistant
    ? []
    : ["name", "domain", "backend", "frontend", "database", "identity"];
  for (const key of (
    ["backend", "frontend", "database", "identity"] as const
  ).filter((key) => asked.includes(key) && given[key] !== undefined)) {
    const allowed: readonly string[] = choices[key];
    if (!allowed.includes(given[key] ?? "")) {
      io.stderr(`--${key} must be one of ${allowed.join(", ")}\n`);
      return 1;
    }
  }
  const defaults =
    io.prompts && asked.some((key) => !answers[key])
      ? detectProject(await readRepository(io.cwd))
      : {};
  for (const key of asked) {
    if (answers[key]) continue;
    if (!io.prompts) {
      io.stderr(
        `missing --${key}; run init in a terminal to be asked, or pass every option\n`,
      );
      return 1;
    }
    const answer = await askFor(key, answers, defaults, io);
    if (answer === undefined) {
      io.stderr(`init ${cancelled}\n`);
      return 130;
    }
    answers[key] = answer;
  }
  const assistant = await resolveAssistants(option, io, onlyAssistant);
  if (assistant === cancelled) {
    io.stderr(`init ${cancelled}\n`);
    return 130;
  }
  if (typeof assistant === "string") {
    io.stderr(`${assistant}\n`);
    return 1;
  }
  if (onlyAssistant && assistant.length === 0) {
    io.stderr(
      `--only-assistant needs an assistant: --assistant ${assistantNames.join(", ")}, or a list such as ${assistantNames.join(",")}\n`,
    );
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
    ? assistantFiles(assistant, version)
    : filesFor({ ...(answers as Omit<Answers, "assistant">), assistant });
  const config = files["turbo-vibe.yaml"];
  const parsed = config === undefined ? undefined : parseConfig(config);
  if (parsed && !parsed.ok) {
    for (const { message } of parsed.problems) io.stderr(`${message}\n`);
    return 1;
  }
  const written = await writeFiles(files, force, io);
  if (written !== 0) return written;
  if (onlyAssistant || !parsed?.ok) return 0;
  await ignoreWorkingFiles(io);
  const { prompts } = io;
  if (!prompts || !io.ask || !io.askSecret) {
    io.stdout(nextSteps({ setup: "no terminal" }));
    return 0;
  }
  if (!(await githubSignedIn(io))) {
    io.stdout(nextSteps({ setup: "signed out" }));
    return 0;
  }
  const now = await prompts.confirm("Set up your accounts now?");
  if (!now) {
    io.stdout(nextSteps({ setup: "declined" }));
    return 0;
  }
  const code = await setup(
    parsed.config,
    { env: defaultEnvironments(parsed.config) },
    io,
  );
  if (code === 130) return code;
  io.stdout(nextSteps({ setup: code === 0 ? "ready" : "failed" }));
  return code;
}

type SetupOutcome =
  | "ready"
  | "failed"
  | "declined"
  | "signed out"
  | "no terminal";

function nextSteps({ setup }: { setup: SetupOutcome }): string {
  const cli = `npx @turbo-vibe/cli@${cliRange}`;
  const connect = `Connect your accounts: ${cli} setup (${cli} setup --list names what you need first: https://github.com/dannycalleri/turbo-vibe/blob/main/docs/bootstrap.md)`;
  const first: Record<SetupOutcome, string[]> = {
    ready: [],
    failed: [
      `Fix what setup reported above, then run ${cli} setup again: it keeps what it stored and checks again (a new zone stays pending until your registrar uses its nameservers)`,
    ],
    declined: [connect],
    "signed out": [
      `${connect}; it needs a signed-in GitHub CLI, so run gh auth login first`,
    ],
    "no terminal": [`${connect}, in a terminal`],
  };
  const steps = [
    ...first[setup],
    "Commit these files and push to main: every push deploys to staging",
    'To go live, run "Deploy to production" in the Actions tab, type the build ID and approve it',
  ];
  return [
    "",
    "Next steps:",
    ...steps.map((step, index) => `  ${index + 1}. ${step}`),
    "",
  ].join("\n");
}

const workingFolder = ".turbo-vibe/";

async function ignoreWorkingFiles(io: Io): Promise<void> {
  const path = join(io.cwd, ".gitignore");
  const current = await readFile(path, "utf8").catch(() => undefined);
  const lines = (current ?? "").split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => /^\/?\.turbo-vibe\/?$/.test(line))) return;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${current ?? ""}${separator}${workingFolder}\n`);
  io.stdout(
    current === undefined
      ? `wrote .gitignore, ignoring ${workingFolder}\n`
      : `added ${workingFolder} to .gitignore\n`,
  );
}

async function writeFiles(
  files: Record<string, string>,
  force: boolean,
  io: Io,
): Promise<number> {
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
  return 0;
}

export async function adopt(
  option: AssistantOption,
  { force }: { force: boolean },
  io: Io,
): Promise<number> {
  const assistant = await resolveAssistants(option, io, true);
  if (assistant === cancelled) {
    io.stderr(`adopt ${cancelled}\n`);
    return 130;
  }
  if (typeof assistant === "string") {
    io.stderr(`${assistant}\n`);
    return 1;
  }
  if (assistant.length === 0) {
    io.stderr(
      `adopt writes guidance for a coding assistant: pass --assistant ${assistantNames.join(", ")}, or a list such as ${assistantNames.join(",")}\n`,
    );
    return 1;
  }
  const files = adoptionFiles(assistant, version);
  const written = await writeFiles(files, force, io);
  if (written !== 0) return written;
  if (await excludeFromGit(Object.keys(files), io)) {
    io.stdout(
      "listed the guidance in .git/info/exclude, so it is never committed\n",
    );
  }
  io.stdout(
    'next: ask your coding assistant to "make this project deployable with turbo-vibe"; it follows the turbo-vibe-adopt guidance\n',
  );
  return 0;
}

// The adoption guidance is a one-off; keeping it out of git spares the assistant a commit it would have to undo.
async function excludeFromGit(names: string[], io: Io): Promise<boolean> {
  const git = join(io.cwd, ".git");
  const isRepository = await stat(git).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
  if (!isRepository) return false;
  const exclude = join(git, "info", "exclude");
  const existing = await readFile(exclude, "utf8").catch(() => "");
  const listed = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = names
    .map((name) => `/${name}`)
    .filter((line) => !listed.has(line));
  if (missing.length === 0) return false;
  await mkdir(dirname(exclude), { recursive: true });
  await writeFile(
    exclude,
    `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`,
  );
  return true;
}
