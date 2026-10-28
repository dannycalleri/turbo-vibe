import { access } from "node:fs/promises";
import { join } from "node:path";
import { adapters } from "./adapters/index.js";
import { buildIdPath, kitHealthPath } from "./adapters/wrangler.js";
import { updatePermissionsQuestion } from "./checks/cloudflare.js";
import { reservedNames } from "./config/load.js";
import { serviceKinds } from "./config/schema.js";
import {
  backendPrefix,
  buildIdVariable,
  defaultBackendPort,
} from "./contract.js";
import { vendorSteps } from "./setup/steps.js";
import { references } from "./version.js";

export const assistantNames = ["claude", "cursor"] as const;
export type AssistantName = (typeof assistantNames)[number];

// `both` and `none` were the only choices before the list; keeping them keeps old commands working.
const aliases: Readonly<Record<string, readonly AssistantName[]>> = {
  both: assistantNames,
  none: [],
};

export function parseAssistants(
  values: readonly string[],
): AssistantName[] | string {
  const names: AssistantName[] = [];
  let named = false;
  for (const value of values.flatMap((entry) => entry.split(","))) {
    const name = value.trim();
    if (!name) continue;
    const expanded =
      aliases[name] ??
      ((assistantNames as readonly string[]).includes(name)
        ? [name as AssistantName]
        : undefined);
    if (!expanded)
      return `unknown assistant ${name}; choose from ${assistantNames.join(", ")}, as a comma-separated list`;
    for (const each of expanded) if (!names.includes(each)) names.push(each);
    named = true;
  }
  return named
    ? names
    : `no assistant named; choose from ${assistantNames.join(", ")}, as a comma-separated list`;
}

const markers: Readonly<Record<AssistantName, readonly string[]>> = {
  claude: [".claude", "CLAUDE.md"],
  cursor: [".cursor", ".cursorrules"],
};

export async function detectAssistants(cwd: string): Promise<AssistantName[]> {
  const found: AssistantName[] = [];
  for (const name of assistantNames) {
    for (const marker of markers[name]) {
      if (
        await access(join(cwd, marker)).then(
          () => true,
          () => false,
        )
      ) {
        found.push(name);
        break;
      }
    }
  }
  return found;
}

const description =
  "Deploying this project with turbo-vibe: editing turbo-vibe.yaml, checking a plan, guiding a person through account setup, and leaving production promotion to a person.";

const adoptDescription =
  "Making an existing project deployable with turbo-vibe: mapping its parts to the targets turbo-vibe runs, adapting the backend to the deploy contract, writing turbo-vibe.yaml and the workflows, and checking it all locally before a person sets up the accounts.";

const cli = (version: string) =>
  `npx @turbo-vibe/cli@${references(version).cliRange}`;

const contract = `- A backend needs no health route and no Dockerfile lines for turbo-vibe. After every deploy, the kit's Worker checks that the container answers \`container.health\` with HTTP 2xx when the config sets it, else \`/\` below HTTP 500. The container receives the build ID as \`${buildIdVariable}\`. Only the backend's \`paths\` reach it, \`${backendPrefix}\` by default. It listens on its port: \`container.port\` when the config sets it, else the \`EXPOSE\` in the Dockerfile's final stage, else ${defaultBackendPort}. turbo-vibe also gives the port as \`PORT\`.`;

const tokenSteps = () =>
  vendorSteps
    .map((step) =>
      [
        `### ${step.vendor}, for ${step.neededBy}`,
        "",
        ...step.clicks.map((click, index) => `${index + 1}. ${click}`),
        "",
        `Permissions: ${step.permissions}. Page: ${step.url}`,
      ].join("\n"),
    )
    .join("\n\n");

const tokenGuide = () => `## Creating each token

\`setup\` shows these same steps, one vendor at a time, and offers to open each page; \`setup --list\` names the plan each one needs for this project. When the person asks how to create a token, give them its steps here, in the chat. They paste the value only into \`setup\`, in their own terminal, never into the chat.

${tokenSteps()}`;

const guidance = (version: string) => `# turbo-vibe

This project is deployed by turbo-vibe ${version}. \`turbo-vibe.yaml\` at the repository root describes its services (backend, frontend, database, sign-in) and where each runs. A merge to \`main\` deploys staging; a person promotes the build that passed staging to production.

## Changing what is deployed

- Change infrastructure only by editing \`turbo-vibe.yaml\`. Never create, change or delete vendor resources by hand or with vendor CLIs (\`wrangler deploy\`, \`vercel deploy\`, \`supabase projects create\`): turbo-vibe owns them, and its next run would undo the change.
- The file's first line points at its JSON Schema; every field is described at https://github.com/dannycalleri/turbo-vibe/blob/main/docs/file-format.md.
- After every edit, run \`${cli(version)} plan\`. It validates the file and lists each environment's services and addresses, without credentials.
- When credentials are available, run \`plan --env staging\` before proposing a change and show the person its summary. Point out every line under "Deletions and replacements": those destroy data or traffic.
- Never pass \`--allow-deletions\`, or tick the workflows' allow-deletions input, unless the person has agreed to the specific deletions \`plan\` listed.
- To make an environment private, add \`access.emails\` to it in \`turbo-vibe.yaml\`, run \`plan\`, and let the person push. On a hostname that Cloudflare serves, tell them that \`${buildIdPath}\` and \`${kitHealthPath}\` stay public, so the smoke test can read them. Do not ask them to enable Zero Trust or to change a token first: the CI tokens \`setup\` creates already have the permission, and \`check\` says when Zero Trust is off. Only when a check or a run reports a missing permission, send them to run \`setup\` in their own terminal and answer y to "${updatePermissionsQuestion}". Only when it reports that Access is not available, give them the Zero Trust link from that report: they choose a team name and the Free plan. A project with no service on a Cloudflare target needs no Zero Trust. A hostname on Vercel gets Vercel Authentication instead, which lets in the members of the Vercel team, not a list: tell the person that each listed address needs a place in the team, which they manage in Vercel, and that every member gets in too. Vercel gives the smoke test's bypass secret to every deployment as \`VERCEL_AUTOMATION_BYPASS_SECRET\`, so server code must never return its environment variables.

## Setting up the accounts

When the person asks to set up the project's accounts, or a run fails on a missing account, token or secret:

1. Run \`${cli(version)} setup --list\`. It reads only \`turbo-vibe.yaml\` and prints the accounts, the plans, and the steps only a person can do, each with a link. Walk the person through those steps one at a time, and through each token with its steps under "Creating each token".
2. Tell the person to run \`${cli(version)} setup\` in their own terminal. It asks for each token without echoing it, creates the Cloudflare resources, and stores every secret in the GitHub environments. Never run \`setup\` yourself: it needs a person at the terminal.
3. Never ask for a secret value, and never accept one in the chat. If the person pastes a token, do not use it, store it or repeat it. Tell them to revoke it and create a new one, because the conversation keeps a copy.
4. Read \`setup\`'s final report with the person, and explain each \`FAIL\` line with its fix. A \`FAIL\` on a value \`setup\` stored is fixed with \`setup --replace <SECRET>\`; a plain second run keeps what exists.

When the application needs a new value of its own, add its name to the field of its kind in \`turbo-vibe.yaml\`: \`secrets\` for a secret its server reads (one value per environment), \`public\` for a value a frontend build inlines (one per environment), \`build.secrets\` for a secret only the build needs (one for the repository). Then tell the person to run \`${cli(version)} setup\`, which asks only for what is missing. A deploy stops, naming the value, until it exists.

Never invent tokens, and never print or commit a secret value. \`setup\` stores every value: runtime secrets and public values in each GitHub environment (\`staging\`, \`production\`, and \`preview\` with previews), build secrets once in the repository. \`check --env staging\` names what is missing without changing anything, but it needs that environment's values, which only GitHub holds once \`setup\` has stored them.

${tokenGuide()}

## Production is promoted by a person

Do not run \`promote\`, \`ship\`, \`apply --env production\` or \`migrate --env production\`, and do not start the "Deploy to production" workflow. Prepare the change and open a pull request. After it merges, staging deploys. Tell the person to approve the Staging run's **production** job (Review deployments) when the \`production\` environment has a required reviewer; otherwise, to run "Deploy to production" with the build ID that the run summary names as \`confirm-build\`. \`turbo-vibe ship\` in their own terminal does the same: it lists the builds that passed staging and starts the workflow with the one they choose, also for a rollback. Suggest it; do not run it.

## What the code must keep doing

${contract}
- Database changes are new files under \`supabase/migrations/\` in the database service's \`workdir\` (the repository root by default); never edit one that has already been applied. The running app connects with a role that cannot change the schema.
`;

const targetRuns: Record<string, string> = {
  "cloudflare-container":
    "an HTTP server in any language, built from a Dockerfile and run as a container",
  "cloudflare-static": `a static site or single-page app: a build command that writes HTML, JS and CSS to a folder. With a backend it is served from the backend's Worker: the page at \`/\`, the API at the backend's \`paths\` (\`${backendPrefix}\` by default). By default unknown paths get \`index.html\` with \`200\`, so a single-page app's client-side routing works; a site with one file per page (Astro, Hugo, Docusaurus) sets \`not_found: 404-page\` and ships a root \`404.html\`, so unknown paths get \`404\`.`,
  "vercel-static":
    "the same kind of static build, hosted on Vercel; the backend then moves to its own API hostname, and the page reads the API's URL at run time",
  "vercel-nextjs":
    "a Next.js app, built with `vercel build`; server-rendered pages and route handlers become Vercel functions",
  supabase:
    "a PostgreSQL database: one Supabase project per environment, changed only by SQL migration files",
  workos:
    "sign-in with WorkOS AuthKit; the backend handles the login callback at `callback_path`, under one of its `paths` (`/api/auth/callback` by default)",
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

const reservedList = () => {
  const { service, credentials } = reservedNames();
  return [...Object.keys(service), ...Object.keys(credentials)]
    .map((name) => `\`${name}\``)
    .join(", ")
    .concat(", and any name that starts with `GITHUB_` or `TURBO_VIBE_`");
};

const adoptGuidance = (version: string) => `# Adopting turbo-vibe

Use this when the person asks to make this existing project deployable with turbo-vibe ${version}. The goal is one pull request after which a merge to \`main\` deploys staging, and a person promotes that same build to production. turbo-vibe creates everything in the person's own accounts (Cloudflare, and Supabase, Vercel or WorkOS when a part needs them), from \`turbo-vibe.yaml\` and two GitHub workflows.

Work in this order and stop where a step says so. Report to the person after steps 1, 2 and 6.

## Rules for the whole task

- Never create accounts, tokens or vendor resources, never run \`setup\`, \`apply\`, \`deploy\` without \`--dry-run\`, \`migrate\` or \`promote\`, and never ask for or accept a secret value. The person does account setup in step 7.
- Change how the application behaves only where this guide requires it, and say why each time. Ask before any change the person would notice; step 2 gathers those questions.
- Keep the changes reviewable: on a branch, never on \`main\`, with one commit for each step that changes files. Never commit this guide's own files: \`adopt\`, run at a repository's root, lists them in \`.git/info/exclude\`; if \`git status\` still shows them, leave them unstaged. Step 7 deletes them.
- Keep local development working: when a change alters how the app starts or finds its database or API, update the project's README or scripts in the same commit, or add a short README section if there is none.

## 1. Inspect the repository (read only)

Find and list, with the file that shows each:

- **Servers:** every process that answers HTTP. Its language and framework, its start command, the port it listens on, its route prefixes, and any server-rendered pages.
- **Frontends:** a single-page app or static site (its build command and output folder), or a Next.js app. Note workspaces or a monorepo layout, and whether a lockfile exists.
- **Data:** the database engine, how the app gets its connection (environment variable name), and how the schema changes (SQL files, Prisma, Drizzle, Alembic, Django or Rails migrations, or tables created at start-up).
- **Everything else the app needs to run:** environment variables and secrets it reads (API keys, OAuth secrets), sign-in, background workers, scheduled jobs, queues, file uploads to local disk, and other services in \`docker-compose.yml\`.
- **How it ships today:** \`Dockerfile\`, \`fly.toml\`, \`vercel.json\`, \`render.yaml\`, \`Procfile\`, CI workflows, and the domain it is served on.

## 2. Map each part to a target, or stop

| Kind | Target | Runs | \`init\` flag |
|---|---|---|---|
${targetTable()}

A project has at most one service of each kind. Present the mapping as a table, and list every part that has no row above:

- **Another SQL database** (SQLite, MySQL): it can move to PostgreSQL if the person agrees. That is a change to the data-access code plus a first migration.
- **Existing data**, in any database: each environment starts with an empty database. Copying data in is not covered by this guide; say so, and ask whether it matters.
- **Files written to local disk that must persist:** a container's disk is lost on every deploy and whenever it sleeps. Data belongs in the database; uploaded files have no target yet.
- **A second backend or frontend, background workers, scheduled jobs and queues.**

The application's own values each go in the field of their kind, and \`setup\` later asks the person for them:

| What the application reads | Field | Values |
|---|---|---|
| A secret its server reads while it runs (a payment key, an email or LLM API key), in a backend or a Next.js app's server code | the service's \`secrets\` | one per environment: test keys on staging and previews, live keys in production |
| A value its frontend build inlines (\`NEXT_PUBLIC_*\`, \`VITE_*\`, anything a build script writes) | the frontend's \`public\` | one per environment; the build sees a placeholder that each deploy replaces |
| A secret only its build needs (a private registry token, a source-map upload token) | the service's \`build.secrets\` | one for the whole repository |

- A \`public\` value must be an identifier, a key or a DSN, never a switch that the build compares: during the build the code sees the placeholder.
- A Next.js page that reads a runtime secret must render per request (\`cookies()\`, \`headers()\`, \`connection()\`, or \`export const dynamic = "force-dynamic"\`); a page rendered during the build sees no secret.
- A plain setting that is not secret, such as \`LOG_LEVEL\`, goes in \`secrets\` too.
- The kit already uses some names in the same GitHub environments. If the application reads one of them for its own value, rename it in the application, such as \`APP_\` followed by the name: ${reservedList()}.
- A backend receives no other variables than its declared \`secrets\` and the kit's own: \`PORT\`, \`${buildIdVariable}\`, \`DATABASE_URL\` with a database, \`WORKOS_CLIENT_ID\`, \`WORKOS_API_KEY\` and \`WORKOS_REDIRECT_URI\` with sign-in, and \`ALLOWED_ORIGINS\` and \`FRONTEND_URL\` with a frontend on Vercel.

If the application cannot start or serve its main pages without a part that has no target, stop here and tell the person what is missing. Do not build a workaround: a turbo-vibe change may add it. If it can run without it (a scheduled job that can wait, an optional integration), ask whether to proceed without it, and make sure that code path does nothing when its variable is unset.

Then ask the person, in one message, everything this guide needs them to decide, with your recommendation for each:

- the production hostname: \`domain\` in \`turbo-vibe.yaml\`, and whether it serves something today. If it does, the person removes the old DNS record just before the first **Deploy to production**, which is the cutover, or chooses a new hostname: Cloudflare refuses the new record next to an old CNAME, and next to an old A or AAAA record both would answer and traffic would move as soon as production's infrastructure is applied, before the app is promoted. Its zone (the registered domain, such as \`example.com\`) must be on Cloudflare; if it is not yet, \`setup\` adds it, and the person then moves the zone's nameservers to Cloudflare, which moves DNS for the whole zone, email and other sites included. Tell them the staging hostname \`init\` will derive: one level below the zone, such as \`staging-shop.example.com\` for \`shop.example.com\`, because Cloudflare's free certificate covers only that level;
- each part with no target: stop, or proceed without it;
- each of the application's own values, with its field from the table above, so they know what \`setup\` will ask for;
- each change from steps 3 and 4 they would notice: the port, the backend's \`paths\`, pages or routes that stop being served, an open CORS policy tightened, start-up steps removed, new dependencies or a lockfile;
- the database's region, near the app's users.

## 3. Make the backend meet the contract

Skip this step for a project with no backend. Each change below can break the way the project ships today (a different port, a required \`DATABASE_URL\`, moved routes); say in the pull request whether the old configuration still works, and keep it until the person retires it.

1. **Dockerfile.** Use the existing one, or write one. turbo-vibe builds it for \`linux/amd64\` itself, so do not put \`--platform\` in \`FROM\`. Keep the language version the project uses; if it pins none, use the current LTS and say so. In a monorepo or workspace, build from the repository root (\`build.context: .\` in step 5) and install only what the server needs: with npm workspaces, copy the root \`package.json\` and lockfile and every workspace's \`package.json\` before \`npm ci --workspace <server>\`. \`npm ci\` and similar need a lockfile, so generate one if the project has none. Add a \`.dockerignore\` for dependencies and build output. Add nothing for turbo-vibe: the container receives the build ID as \`${buildIdVariable}\` at run time, and the build gets it as a build argument of the same name, for a Dockerfile that wants it.

   A secret only the build needs (step 2's \`build.secrets\`) arrives as a BuildKit secret: read it with \`RUN --mount=type=secret,id=<NAME> <NAME>="$(cat /run/secrets/<NAME>)" <command>\`, and never put it in an \`ARG\`, an \`ENV\` or a copied file. Use the exec form for the start command (\`CMD ["node", "server.js"]\`), not the shell form, so the server receives signals itself. The exec form does not expand \`$PORT\`: read it in the server's code or its config file (gunicorn's \`gunicorn.conf.py\`), or use \`CMD ["sh", "-c", "exec <server> --port $PORT"]\`.
2. **Port.** Keep the port the server uses. turbo-vibe sends requests to \`container.port\` when step 5's config sets it, else to the TCP port of the last \`EXPOSE\` that has one in the Dockerfile's final stage, or in the stage it builds on, else to ${defaultBackendPort}, and gives the same port as \`PORT\`. When the Dockerfile has \`EXPOSE\` with the right port, change nothing. Otherwise add that \`EXPOSE\`, or set \`container.port\`. The server must listen on \`0.0.0.0\`, not only on \`127.0.0.1\`.
3. **Paths.** Keep the routes where they are. Only the backend's \`paths\` reach it, \`${backendPrefix}\` by default; every other path is answered by the frontend, or not at all. List the prefixes the app's routes use in \`paths\` (step 5), such as \`[/v1/, /auth/]\`. A backend that no frontend shares a hostname with can take \`[/]\`. On a project already deployed with turbo-vibe, a change of \`paths\` replaces routes: tell the person to run the Staging workflow once with \`allow-deletions\`, and to pass it to the next "Deploy to production". Change routes only for server-rendered pages beside a \`cloudflare-static\` frontend, which needs \`/\`: drop them, move them under one of the paths, or turn them into the frontend, as the person chose. The sign-in \`callback_path\` must sit under one of the paths. With the frontend on the same host, the API no longer needs cross-origin access, so an open CORS policy can be tightened: remove it, or allow only the local dev server's origin.
4. **Health.** Change nothing: after every deploy, turbo-vibe checks that the server answers \`/\` below HTTP 500, and a 404 passes. Only when the app already has a readiness route that answers HTTP 2xx without the database (the pull request's dry run starts the image without one), set \`container.health\` to its path in step 5.
5. **Stop on \`SIGTERM\`.** Each deploy replaces the container by sending \`SIGTERM\`, and waits up to 15 minutes for one that ignores it. Go servers and gunicorn exit by default. Node, and Python servers that run as process 1 without such a manager, need a handler that closes the server and exits, or an init such as \`tini\` as the entrypoint.
6. **Database.** Read the connection string from \`DATABASE_URL\`. It points at the database's session pooler and includes \`sslmode=require\`, so a driver that reads the URL needs no TLS or prepared-statement options. The pooler closes idle connections: handle a pool's connection errors so they do not crash the process (node-postgres: \`pool.on("error", …)\`). Migrations run before each deploy as a role that owns the schema, and the running app connects as one that can read and write rows but cannot change the schema; it gets those rights, sequences included, on everything the migrations create, so write no \`GRANT\`s. Remove any migration or table creation at start-up. Schema changes become SQL files in \`supabase/migrations/\`, named \`<YYYYMMDDHHMMSS>_<name>.sql\` and applied in name order. Copy SQL migrations the project already has (\`prisma/migrations/*/migration.sql\`, Drizzle's output folder, Rails or Django can print theirs) into that folder in their original order, renaming each with an increasing timestamp. Without any, write the SQL that creates the current schema as the first file, or have the tool print it (\`alembic upgrade head --sql\`; for Prisma, \`prisma migrate diff\` from empty to the schema with \`--script\`, whose flag names differ between versions, so check \`--help\`). Keep the tool's own runner out of the deploy. For local development, say how to apply the files, such as \`supabase db reset\` or \`psql\` over each file in order.
7. **Tests.** The \`build.test\` command runs on every pull request, from the folder that holds \`turbo-vibe.yaml\`, on GitHub's \`ubuntu-latest\` runner with Node, npm, Yarn 1, Docker and Python 3, and nothing of the project's installed. For pnpm, start the command with \`corepack enable &&\`. Make it install what the tests need first, such as \`npm ci && npm test\`, or run them in the language's image without leaving files behind: \`docker run --rm -e PYTHONDONTWRITEBYTECODE=1 -v "$PWD":/src -w /src python:3.12 sh -c "pip install -r requirements.txt && pytest -p no:cacheprovider"\`. It receives none of the application's secrets. Tests that need a database must start one in the command (a \`postgres\` container) or stay out of \`build.test\`; ask the person which.

## 4. Point the frontend at the API

- **Served with the backend (\`cloudflare-static\`):** call the API with relative URLs under the backend's \`paths\` (\`${backendPrefix}…\` by default). Remove any hard-coded API host, and keep local development working with the dev server's proxy from each of those paths to the backend's local port (Vite's \`server.proxy\`).
- **On Vercel (\`vercel-static\`):** read the API's URL at run time from \`/_turbo-vibe/config.json\` (\`{ "apiUrl": "https://…" }\`), which each environment gets next to the built files, so one build serves staging and production. The backend must accept only the origins in \`ALLOWED_ORIGINS\`, with credentials.
- **Next.js (\`vercel-nextjs\`):** read the API's URL from \`TURBO_VIBE_API_URL\` on the server.

A frontend's build receives none of the runtime secrets. A value it inlines keeps the framework's own mechanism: list its name in \`public\`, and each environment gets its own value in the same build.

## 5. Write turbo-vibe.yaml and the workflows

Run \`init\` with every flag, so it asks nothing, choosing \`none\` where a kind has no target:

\`\`\`sh
${cli(version)} init --name <project> --domain <production hostname> --backend <target|none> --frontend <target|none> --database <target|none> --identity <target|none> --assistant <claude, cursor or claude,cursor>
\`\`\`

\`--name\` is lowercase letters, digits and hyphens; it names the Workers, the state and the Supabase projects. \`init\` writes \`turbo-vibe.yaml\`, \`.github/workflows/staging.yml\`, \`.github/workflows/production.yml\`, and the guidance for working on the project afterwards, and adds \`.turbo-vibe/\` to \`.gitignore\`. Commit what it writes, the guidance included. It never overwrites a file: if one of those exists, move it aside with the person's agreement and merge what it did by hand.

Then edit \`turbo-vibe.yaml\` (each field is described at https://github.com/dannycalleri/turbo-vibe/blob/main/docs/file-format.md). Paths and commands are relative to the folder that holds it:

- \`build.dockerfile\`, \`build.context\` when the Dockerfile builds from another folder, and \`build.test\`;
- \`paths\`, when step 3 listed prefixes other than \`${backendPrefix}\`;
- \`container.port\`, when step 3 chose it over an \`EXPOSE\`, and \`container.health\`, when step 3 chose a readiness route;
- the frontend's \`build.command\`, \`build.output\` and \`build.test\`, replacing the defaults \`init\` marks;
- the \`secrets\`, \`public\` and \`build.secrets\` lists from step 2;
- with a database, its \`region\`, as the person chose. Leave its \`organization\` line commented out: \`setup\` finds the Supabase organization and stores it as a secret, so its slug stays out of the repository.

## 6. Check it locally

Run each command, fix what fails, and run it again:

1. \`${cli(version)} plan\` → staging and production, each service with its address, and the backend's port with where it came from. Check that the port is the one the server listens on. It needs no credentials.
2. \`${cli(version)} test\` → each service's \`build.test\` passes.
3. \`${cli(version)} deploy --env staging --dry-run --build-id local\` → each service builds, and the backend's container answers its health probe (\`/\`, or \`container.health\`) on its port and stops on \`SIGTERM\`. It needs Docker and no credentials, and ends with \`dry run passed\`. Its error names what to fix.
4. With a database, apply the migrations to a throwaway PostgreSQL: \`docker run -d --name migrations-check -e POSTGRES_PASSWORD=check postgres:17\`, wait until \`docker exec migrations-check pg_isready -h 127.0.0.1\` succeeds (without \`-h\` it can answer for the image's set-up server), run each file in name order with \`docker exec -i migrations-check psql -U postgres -v ON_ERROR_STOP=1 < <file>\`, then \`docker rm -f migrations-check\`. Every file must apply without an error.
5. Only if the dry run says the container exited by itself (it needs variables to start, such as \`DATABASE_URL\`), check by hand: \`docker build --platform linux/amd64 -t app .\`, then \`docker run -d --name app-check -p <port>:<port> app\`, with the port that \`plan\` prints for the backend, adding \`-e NAME=placeholder\` for any variable the app needs to start, such as \`DATABASE_URL\`. Then \`curl -i localhost:<port>/\` → any status below 500, or HTTP 2xx from the \`container.health\` path when step 5 set one. Finish with \`docker stop app-check\`, which should return at once, and \`docker rm app-check\`.

Report what passed, what you could not run, and why.

## 7. Hand over to the person

1. Delete this guide's own files (\`.claude/skills/turbo-vibe-adopt/\`, \`.cursor/rules/turbo-vibe-adopt.mdc\`) without committing them: the guidance \`init\` wrote replaces them.
2. Open the pull request. Its description lists the mapping and the person's answers from step 2, every behaviour change from steps 3 and 4 (port, routes, start-up steps, local development), what may stop working in the way the project ships today, and the results of step 6. On this pull request the Staging workflow only runs each service's tests and the dry run, without secrets; nothing deploys until \`main\`.
3. Run \`${cli(version)} setup --list\` and walk the person through the accounts, plans and steps it prints, and through each token with its steps under "Creating each token" below. Then tell them to run \`${cli(version)} setup\` in their own terminal: it asks for each token without echoing it and stores every secret in GitHub. Never run it yourself.
4. After the merge, staging deploys. The person promotes it, never you: by approving the Staging run's **production** job, or, without a required reviewer, with the **Deploy to production** workflow and the build ID from the run summary. Once production serves the app, the person can retire the old deploy configuration.

${tokenGuide()}
`;

export function assistantFiles(
  choice: readonly AssistantName[],
  version: string,
): Record<string, string> {
  return wrapped(choice, "turbo-vibe", description, guidance(version), true);
}

export function adoptionFiles(
  choice: readonly AssistantName[],
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
  choice: readonly AssistantName[],
  name: string,
  summary: string,
  body: string,
  scoped: boolean,
): Record<string, string> {
  const files: Record<string, string> = {};
  if (choice.includes("claude")) {
    files[`.claude/skills/${name}/SKILL.md`] =
      `---\nname: ${name}\ndescription: ${JSON.stringify(summary)}\n---\n\n${body}`;
  }
  if (choice.includes("cursor")) {
    files[`.cursor/rules/${name}.mdc`] =
      `---\ndescription: ${JSON.stringify(summary)}\n${scoped ? "globs: turbo-vibe.yaml\n" : ""}alwaysApply: false\n---\n\n${body}`;
  }
  return files;
}
