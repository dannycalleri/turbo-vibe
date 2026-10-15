import { adapters } from "./adapters/index.js";
import { serviceKinds } from "./config/schema.js";
import {
  backendPort,
  backendPrefix,
  buildIdVariable,
  healthPath,
} from "./contract.js";
import { references } from "./version.js";

export const assistants = ["claude", "cursor", "both", "none"] as const;
export type Assistant = (typeof assistants)[number];

const description =
  "Deploying this project with turbo-vibe: editing turbo-vibe.yaml, checking a plan, guiding a person through account setup, and leaving production promotion to a person.";

const adoptDescription =
  "Making an existing project deployable with turbo-vibe: mapping its parts to the targets turbo-vibe runs, adapting the backend to the deploy contract, writing turbo-vibe.yaml and the workflows, and checking it all locally before a person sets up the accounts.";

const cli = (version: string) =>
  `npx @turbo-vibe/cli@${references(version).cliRange}`;

const contract = `- A backend answers \`GET ${healthPath}\` with JSON containing \`build_id\`, taken from the \`${buildIdVariable}\` build argument baked into its image, and listens on port ${backendPort}.`;

const guidance = (version: string) => `# turbo-vibe

This project is deployed by turbo-vibe ${version}. \`turbo-vibe.yaml\` at the repository root describes its services (backend, frontend, database, sign-in) and where each runs. A merge to \`main\` deploys staging; a person promotes the build that passed staging to production.

## Changing what is deployed

- Change infrastructure only by editing \`turbo-vibe.yaml\`. Never create, change or delete vendor resources by hand or with vendor CLIs (\`wrangler deploy\`, \`vercel deploy\`, \`supabase projects create\`): turbo-vibe owns them, and its next run would undo the change.
- The file's first line points at its JSON Schema; every field is described at https://github.com/dannycalleri/turbo-vibe/blob/main/docs/file-format.md.
- After every edit, run \`${cli(version)} plan\`. It validates the file and lists each environment's services and addresses, without credentials.
- When credentials are available, run \`plan --env staging\` before proposing a change and show the person its summary. Point out every line under "Deletions and replacements": those destroy data or traffic.
- Never pass \`--allow-deletions\`, or tick the workflows' allow-deletions input, unless the person has agreed to the specific deletions \`plan\` listed.

## Setting up the accounts

When the person asks to set up the project's accounts, or a run fails on a missing account, token or secret:

1. Run \`${cli(version)} setup --list\`. It reads only \`turbo-vibe.yaml\` and prints the accounts, the plans, and the steps only a person can do, each with a link. Walk the person through those steps one at a time.
2. Tell the person to run \`${cli(version)} setup\` in their own terminal. It asks for each token without echoing it, creates the Cloudflare resources, and stores every secret in the GitHub environments. Never run \`setup\` yourself: it needs a person at the terminal.
3. Never ask for a secret value, and never accept one in the chat. If the person pastes a token, do not use it, store it or repeat it. Tell them to revoke it and create a new one, because the conversation keeps a copy.
4. Read \`setup\`'s final report with the person, and explain each \`FAIL\` line with its fix. A \`FAIL\` on a value \`setup\` stored is fixed with \`setup --replace <SECRET>\`; a plain second run keeps what exists.

Never invent tokens, and never print or commit a secret value. Secrets belong in the GitHub environments \`staging\` and \`production\`. \`check --env staging\` names what is missing without changing anything, but it needs that environment's values, which only GitHub holds once \`setup\` has stored them.

## Production is promoted by a person

Do not run \`promote\`, \`apply --env production\` or \`migrate --env production\`, and do not start the "Deploy to production" workflow. Prepare the change and open a pull request. After it merges, staging deploys and its run summary names the build ID; tell the person to run "Deploy to production" with that ID as \`confirm-build\`.

## What the code must keep doing

${contract}
- Database changes are new files under \`supabase/migrations/\` in the database service's \`workdir\` (the repository root by default); never edit one that has already been applied. The running app connects with a role that cannot change the schema.
`;

const targetRuns: Record<string, string> = {
  "cloudflare-container":
    "an HTTP server in any language, built from a Dockerfile and run as a container",
  "cloudflare-static": `a static site or single-page app: a build command that writes HTML, JS and CSS to a folder. With a backend it is served from the backend's Worker: the page at \`/\`, the API at \`${backendPrefix}\`.`,
  "vercel-static":
    "the same kind of static build, hosted on Vercel; the backend then moves to its own API hostname, and the page reads the API's URL at run time",
  "vercel-nextjs":
    "a Next.js app, built with `vercel build`; server-rendered pages and route handlers become Vercel functions",
  supabase:
    "a PostgreSQL database: one Supabase project per environment, changed only by SQL migration files",
  workos:
    "sign-in with WorkOS AuthKit; the backend handles the login callback under `/api/`",
};

const initFlags: Record<string, string> = {
  backend: "--backend",
  frontend: "--frontend",
  database: "--database",
  identity: "--identity",
};

const targetTable = () =>
  Object.entries(adapters)
    .sort(
      ([, a], [, b]) =>
        serviceKinds.indexOf(a.kind) - serviceKinds.indexOf(b.kind),
    )
    .map(
      ([target, adapter]) =>
        `| ${adapter.kind} | \`${target}\`${adapter.stability === "beta" ? " (beta)" : ""} | ${targetRuns[target]} | \`${initFlags[adapter.kind]} ${target}\` |`,
    )
    .join("\n");

const adoptGuidance = (version: string) => `# Adopting turbo-vibe

Use this when the person asks to make this existing project deployable with turbo-vibe ${version}. The goal is one pull request after which a merge to \`main\` deploys staging, and a person promotes that same build to production. turbo-vibe creates everything in the person's own accounts (Cloudflare, and Supabase, Vercel or WorkOS when a part needs them), from \`turbo-vibe.yaml\` and two GitHub workflows.

Work in this order and stop where a step says so. Report to the person after steps 1, 2 and 6.

## Rules for the whole task

- Never create accounts, tokens or vendor resources, never run \`setup\`, \`apply\`, \`deploy\` without \`--dry-run\`, \`migrate\` or \`promote\`, and never ask for or accept a secret value. The person does account setup in step 7.
- Change how the application behaves only where this guide requires it, and say why each time. Ask before a change the person would notice: a route moving under \`${backendPrefix}\`, a removed start-up step, a new dependency.
- Keep the changes reviewable: one commit per step, on a branch, never on \`main\`.

## 1. Inspect the repository (read only)

Find and list, with the file that shows each:

- **Servers:** every process that answers HTTP. Its language and framework, its start command, the port it listens on, and its route prefixes.
- **Frontends:** a single-page app or static site (its build command and output folder), or a Next.js app.
- **Data:** the database engine, how the app gets its connection (environment variable name), and how the schema changes (SQL files, Prisma, Drizzle, Alembic, Django or Rails migrations, or tables created at start-up).
- **Everything else the app needs to run:** environment variables and secrets it reads (API keys, OAuth secrets), sign-in, background workers, scheduled jobs, queues, file uploads to local disk, and other services in \`docker-compose.yml\`.
- **How it ships today:** \`Dockerfile\`, \`fly.toml\`, \`vercel.json\`, \`render.yaml\`, \`Procfile\`, CI workflows, and the domain it is served on.

## 2. Map each part to a target, or stop

| Kind | Target | Runs | \`init\` flag |
|---|---|---|---|
${targetTable()}

A project has at most one service of each kind. Present the mapping as a table, and list every part that has no row above. Today that includes:

- a database other than PostgreSQL, a second backend or frontend, background workers, scheduled jobs and queues;
- files written to local disk that must persist: a container's disk is lost on every deploy;
- environment variables and secrets of the application's own (a payment key, an email API key): the backend receives only \`PORT\`, \`${buildIdVariable}\`, \`DATABASE_URL\` with a database, \`WORKOS_CLIENT_ID\`, \`WORKOS_API_KEY\` and \`WORKOS_REDIRECT_URI\` with sign-in, and \`ALLOWED_ORIGINS\` and \`FRONTEND_URL\` with a frontend on Vercel.

If the application cannot start or serve its main pages without such a part, stop here and tell the person what is missing. Do not build a workaround: a turbo-vibe change may add it. If it can run without them (a scheduled job that can wait, an optional integration), ask whether to proceed without them.

Choose the production hostname with the person: \`domain\` in \`turbo-vibe.yaml\`, a name in a zone they have or will add to Cloudflare. Staging and previews get names one level below the zone, which Cloudflare's free certificate covers.

## 3. Make the backend meet the contract

Skip this step for a project with no backend.

1. **Dockerfile.** Use the existing one, or write one that builds the server for \`linux/amd64\`. In its final stage:

   \`\`\`dockerfile
   ARG ${buildIdVariable}
   ENV ${buildIdVariable}=$${buildIdVariable}
   \`\`\`

   Use the exec form for the start command (\`CMD ["node", "server.js"]\`), not the shell form, so the server receives signals itself.
2. **Port.** Listen on \`0.0.0.0\`, on \`PORT\` when it is set, and on ${backendPort} otherwise.
3. **Routes under \`${backendPrefix}\`.** Only \`${backendPrefix}*\` reaches the backend, whatever else the project has; every other path is answered by the frontend, or not at all. If the routes are elsewhere, mount the router under \`${backendPrefix}\` (ask first), and update the frontend's calls if it has one.
4. **Health.** Answer \`GET ${healthPath}\` with status 200 and JSON containing \`"build_id"\` set to the \`${buildIdVariable}\` environment variable, without touching the database, so a deploy can check it even while the database is slow.
5. **Stop on \`SIGTERM\`.** Each deploy replaces the container by sending \`SIGTERM\`, and waits up to 15 minutes for one that ignores it. Go servers exit by default. Node and Python running as process 1 need a handler that closes the server and exits, or an init such as \`tini\` as the entrypoint.
6. **Database.** Read the connection string from \`DATABASE_URL\`. The running app connects as a role that can read and write rows but cannot change the schema, so remove any migration or table creation at start-up. Schema changes become SQL files in \`supabase/migrations/\`, named \`<YYYYMMDDHHMMSS>_<name>.sql\` and applied in name order. Copy SQL migrations the project already has (\`prisma/migrations/*/migration.sql\`, Drizzle's output folder, Rails or Django can print theirs) into that folder in their original order, renaming each with an increasing timestamp. Without any, write the SQL that creates the current schema as the first file, or have the tool print it (\`alembic upgrade head --sql\`; for Prisma, \`prisma migrate diff\` from empty to the schema with \`--script\`, whose flag names differ between versions, so check \`--help\`). Keep the tool's own runner out of the deploy.
7. **Tests.** Note the command that runs the backend's tests; it goes in \`build.test\` and runs on every pull request.

## 4. Point the frontend at the API

- **Served with the backend (\`cloudflare-static\`):** call the API with relative URLs (\`/api/…\`). Remove any hard-coded API host.
- **On Vercel (\`vercel-static\`):** read the API's URL at run time from \`/_turbo-vibe/config.json\` (\`{ "apiUrl": "https://…" }\`), which each environment gets next to the built files, so one build serves staging and production. The backend must accept only the origins in \`ALLOWED_ORIGINS\`, with credentials.
- **Next.js (\`vercel-nextjs\`):** read the API's URL from \`TURBO_VIBE_API_URL\` on the server.

A frontend's build receives no secrets. A value it inlines at build time is the same in staging and production, so take environment-specific values from the API at run time.

## 5. Write turbo-vibe.yaml and the workflows

Run \`init\` with every flag, so it asks nothing, choosing \`none\` where a kind has no target:

\`\`\`sh
${cli(version)} init --name <project> --domain <production hostname> --backend <target|none> --frontend <target|none> --database <target|none> --identity <target|none> --assistant <claude|cursor|both>
\`\`\`

\`--name\` is lowercase letters, digits and hyphens; it names the Workers, the state and the Supabase projects. \`init\` writes \`turbo-vibe.yaml\`, \`.github/workflows/staging.yml\`, \`.github/workflows/production.yml\`, and the guidance for working on the project afterwards. It never overwrites a file: if one of those exists, move it aside with the person's agreement and merge what it did by hand.

Then edit \`turbo-vibe.yaml\` (each field is described at https://github.com/dannycalleri/turbo-vibe/blob/main/docs/file-format.md):

- \`build.dockerfile\`, \`build.context\` when the Dockerfile builds from another folder, and \`build.test\`;
- the frontend's \`build.command\`, \`build.output\` and \`build.test\`, replacing the defaults \`init\` marks;
- the database's \`region\`, closest to where the backend runs. Delete the \`organization\` line: \`setup\` finds the Supabase organization and stores it as a secret, so its slug stays out of the repository.

Add \`.turbo-vibe/\` to \`.gitignore\`. Remove the old deploy configuration only when the person agrees; until then it does no harm.

## 6. Check it locally

Run each command, fix what fails, and run it again:

1. \`${cli(version)} plan\` → staging and production, each service with its address. It needs no credentials.
2. \`${cli(version)} test\` → each service's \`build.test\` passes.
3. \`${cli(version)} deploy --env staging --dry-run --build-id local\` → each service builds, and the backend's image starts and stops on \`SIGTERM\`. It needs Docker and no credentials.
4. With Docker: \`docker build --platform linux/amd64 --build-arg ${buildIdVariable}=local -t app .\`, then \`docker run -d --name app-check -p ${backendPort}:${backendPort} app\`, adding \`-e NAME=placeholder\` for any variable the app needs to start, such as \`DATABASE_URL\`. Then \`curl localhost:${backendPort}${healthPath}\` → JSON whose \`build_id\` is \`local\`. Finish with \`docker stop app-check\`, which should return at once, and \`docker rm app-check\`.

Report what passed, what you could not run, and why.

## 7. Hand over to the person

1. Open the pull request. Its description lists the mapping from step 2, every behaviour change from steps 3 and 4, and the results of step 6.
2. Run \`${cli(version)} setup --list\` and walk the person through the accounts, plans and steps it prints. Then tell them to run \`${cli(version)} setup\` in their own terminal: it asks for each token without echoing it and stores every secret in GitHub. Never run it yourself.
3. After the merge, staging deploys. Its run summary names the build ID; the person promotes it with the **Deploy to production** workflow, never you.
`;

export function assistantFiles(
  choice: Assistant,
  version: string,
): Record<string, string> {
  return wrapped(choice, "turbo-vibe", description, guidance(version), true);
}

export function adoptionFiles(
  choice: Assistant,
  version: string,
): Record<string, string> {
  return wrapped(
    choice,
    "turbo-vibe-adopt",
    adoptDescription,
    adoptGuidance(version),
    false,
  );
}

function wrapped(
  choice: Assistant,
  name: string,
  summary: string,
  body: string,
  scoped: boolean,
): Record<string, string> {
  const files: Record<string, string> = {};
  if (choice === "claude" || choice === "both") {
    files[`.claude/skills/${name}/SKILL.md`] =
      `---\nname: ${name}\ndescription: ${JSON.stringify(summary)}\n---\n\n${body}`;
  }
  if (choice === "cursor" || choice === "both") {
    files[`.cursor/rules/${name}.mdc`] =
      `---\ndescription: ${JSON.stringify(summary)}\n${scoped ? "globs: turbo-vibe.yaml\n" : ""}alwaysApply: false\n---\n\n${body}`;
  }
  return files;
}
