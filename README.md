# turbo-vibe

The production step after the prototype. turbo-vibe takes an app that works on your laptop and runs it for real users: a staging copy and a production copy, each with its own database, sign-in settings and address; every merge deployed to staging and smoke-tested; and the exact build that passed staging promoted to production after a person approves. Nothing is rebuilt on the way.

You describe the services in one `turbo-vibe.yaml`: a backend, a frontend, a database, sign-in. The kit sets them up on Cloudflare or Vercel, Supabase and WorkOS, in your own accounts. To add it to an existing repository, follow the [adoption guide](docs/adoption.md). For the accounts, plans and tokens it needs, follow the [bootstrap checklist](docs/bootstrap.md). Every field of the file is described in the [file format](docs/file-format.md). Three examples walk from `init` to production step by step: a [Go API with a page, a database and sign-in](examples/go-api/README.md), a [Python API](examples/python-api/README.md), and [Next.js on Vercel](examples/nextjs/README.md) (beta).

```sh
npx @turbo-vibe/cli init
npx @turbo-vibe/cli plan
npx @turbo-vibe/cli plan --env staging
npx @turbo-vibe/cli check --env staging
npx @turbo-vibe/cli test
npx @turbo-vibe/cli apply --env staging
npx @turbo-vibe/cli migrate --env staging
npx @turbo-vibe/cli deploy --env staging --build-id "$(git rev-parse --short HEAD)"
npx @turbo-vibe/cli smoke --env staging --build-id "$(git rev-parse --short HEAD)"
npx @turbo-vibe/cli promote --env production
```

`init` asks for the project's name, domain, and the target of each service, then writes `turbo-vibe.yaml` and the staging and production workflows. It never replaces existing files unless given `--force`. Every answer has a flag (`--name`, `--domain`, `--backend`, `--frontend`, `--database`, `--identity`, `--assistant`) for running it non-interactively. `--assistant claude`, `cursor` or `both` also writes guidance for coding assistants (`.claude/skills/turbo-vibe/SKILL.md`, `.cursor/rules/turbo-vibe.mdc`), stamped with the CLI's version. It teaches them to change infrastructure only through `turbo-vibe.yaml`, to show `plan --env` before proposing a change, to use `check` for missing setup, and to leave production promotion to a person. In a project that already has `turbo-vibe.yaml`, `init --only-assistant --assistant claude` writes just the guidance. It treats a two-label domain (`example.com`) as the zone apex and anything longer as one level below the zone. For a domain on a multi-part suffix, such as `example.co.uk`, edit the hostnames it writes. Build commands, output directories and the Supabase region it fills in are marked as defaults to replace.

`plan` lists the services each environment runs and where, from the file alone. `plan --env <env>` asks OpenTofu what applying that environment would do and prints it per service: what it would create, change, replace or delete, with deletions and replacements listed apart. It prints resource addresses and actions only, never values, and changes nothing.

`check` verifies an environment's accounts, tokens, and tools for the targets the project uses, and changes nothing. It lists every problem with its fix, and exits non-zero until the environment is ready.

`deploy --dry-run` builds everything and validates the Worker without credentials.

## What you are locked into

Nothing that turbo-vibe owns. Every resource lives in your own vendor accounts, and the OpenTofu state and build records live in your own bucket. To stop using the kit, delete `turbo-vibe.yaml` and its workflows; your services keep running where they are.

Moving between vendors is a different question. The kit sets up each host the same way, but a move is still work:

| Part of the app | What moving it takes |
|---|---|
| A static frontend | Possible between `cloudflare-static` and `vercel-static` (beta), with work. On Vercel the page and the API have different origins, so: change `target` and remove `serve_with`; set `api_hostname` where `api.<hostname>` would be two levels below the zone; make the backend accept only `ALLOWED_ORIGINS`; and have the page read its API URL from `/_turbo-vibe/config.json`. See [Static frontends on Vercel](#static-frontends-on-vercel-beta). Moving back means adding `serve_with` again. |
| A Next.js frontend | Not through the kit: `vercel-nextjs` (beta) is its only target. |
| A backend container | Not through the kit yet: `cloudflare-container` is its only target. The image is built from your own Dockerfile and runs on any container host, given `BUILD_ID` as a build argument and, at runtime, `PORT`, `DATABASE_URL` and the sign-in and origin settings. If it sets `container.instance_from`, the new host must route those requests to the same instance itself. |
| Database data | No. Moving a Supabase database's data to another provider is your own migration. |
| Signed-in users | No. Users and their sessions stay in WorkOS. |

Targets marked **beta** are supported and tested on every change, with less history in live runs than the others. [COMPATIBILITY.md](COMPATIBILITY.md) lists, for each adapter, the tool and provider versions this release pins and the last date it passed a live run.

## Build once, promote the same build

A staging `deploy` builds every service once and records what it shipped in the state bucket, at `<project>/builds/<build id>.json`:
- the container image's registry digest (`docker build`, then `wrangler containers push`);
- an archive of each static frontend's built files.

`smoke --env staging` marks that record `passed` or `failed`.

`promote --env production` picks the newest staging build that passed. Newer failed or unchecked builds are skipped. It deploys only that build's recorded outputs: the same image digest, and the same files unpacked from the archive. Nothing is built again. With no passing build, it stops before changing anything. `promote --choose` prints the build it would promote and changes nothing. `promote --build-id <id>` promotes exactly that build, and refuses it unless it passed on staging. Use the two together to migrate production from the chosen build's commit before deploying it. `deploy --env production` is refused, so production only ever runs promoted builds.

## Deploy to production

The reusable `promote.yml` workflow is the "Deploy to production" button: call it from a `workflow_dispatch` workflow, the way `.github/workflows/production.yml` does for the kit's example. Its job runs in the GitHub environment `production`. Two safeguards stand before any production change:

- **Typed confirmation.** The run asks for `confirm-build`, the ID of the build to promote; each passing Staging run prints it in its summary. If it is not the build promotion would choose, the run stops before changing anything and its summary names the right one.
- **Required reviewers.** Give the `production` environment required reviewers once (Settings → Environments), and every run waits for an approval before any production secret is used. GitHub offers them on public repositories and on paid plans; on a private repository on GitHub Free, the typed confirmation is the safeguard.

It then:

1. chooses the latest staging build that passed, and checks it is the confirmed one (`promote --choose --confirm <id>`);
2. checks out that build's commit, so production's infrastructure and migrations match the code being promoted;
3. runs `apply`, then `migrate`, then `promote --build-id <id>` with the recorded image digests and asset archives, then `smoke`.

Nothing is built. Production's resources come from the same adapters as staging's: its own Worker routes and DNS on the project domain, its own Supabase project, and the callback registered in the WorkOS production environment with the production key.

## Actions minutes per run

Public repositories run GitHub's standard runners at no cost. In a private repository, each run spends minutes from the account's allowance (2,000 a month on GitHub Free). The test-and-build job below was measured on the kit's example. The deploy figures are estimates from their steps.

| Run | Jobs | Minutes |
|---|---|---|
| Pull request | test and build (`test`, `deploy --dry-run`) | about 2 (measured 1.5–2) |
| Merge to `main` | test and build, then deploy staging (`apply`, `migrate`, Docker build and push, `deploy`, `smoke`) | about 7–10, estimated |
| Deploy to production | one job: `apply`, `migrate`, `promote`, `smoke`, with no build | about 3–5, estimated |

The image build dominates staging. Promotion skips it, which is why it costs less.

## Sessions on their own container

By default every request reaches one container instance, named `default`. A backend that keeps per-session state, such as WebSocket rooms, can route each request to the instance its query parameter or header names. Requests without one still go to `default`:

```yaml
    container:
      instance_from: query:session   # or header:x-session
      max_instances: 3               # required with instance_from, at least 2
```

WebSocket upgrades are forwarded with `fetch`, so a connection stays on the instance it reached. Sessions and `default` share `max_instances`: once that many are running, a request for any other name fails, the smoke test's `/api/health` included. Size it for the sessions you expect at once, plus one. `examples/python-api` routes by `?session=`.

## Previews

With `previews: true`, each pull request from a branch of the repository can get its own environment:

```sh
npx @turbo-vibe/cli preview deploy --branch "$BRANCH" --build-id "$SHA"
npx @turbo-vibe/cli preview remove --branch "$BRANCH"
```

- **Naming:** the preview is named after the branch, and its hostnames sit next to staging's. A branch that is already hostname-safe keeps its name: `feature-login` on `staging-shop.example.com` becomes `feature-login-staging-shop.example.com`. Any other name, or a long one, is normalized and given a short hash, so two branches never share a preview: `feature/login` becomes `feature-login-<6 hex>-staging-shop.example.com`.
- **Resources:** it has its own OpenTofu state, Workers, Vercel projects, and sign-in callback. The callback is registered in WorkOS's staging environment, because previews run with staging's credentials.
- **Database:** a project with a database gets a Supabase branch, which needs a paid plan. On the free plan, `preview deploy` makes no preview and says why.
- **Removal:** `preview remove` deletes the preview's container application and destroys the preview's own state. It refuses to destroy anything that is not a preview.
- **Promotion:** preview builds are never recorded, so they cannot be promoted.

The reusable `preview.yml` workflow runs this for you on `pull_request` events: `opened`, `synchronize` and `reopened` deploy, `closed` removes. It runs in the `staging` GitHub environment and posts the preview URL (or the reason there is none) as a comment on the pull request. A pull request from a fork gets no preview, because its run receives no secrets, and the run says so. `.github/workflows/previews.yml` previews the kit's Python and Vercel examples.

## What a backend must do

A `cloudflare-container` backend listens on port 8080 (also given as `PORT`), reads its database, if the project has one, from `DATABASE_URL`, and answers `GET /api/health` with JSON containing `build_id`. The kit passes the build ID to `docker build` as the build argument `BUILD_ID`; the Dockerfile's final stage turns it into the environment variable the app reports:

```dockerfile
ARG BUILD_ID
ENV BUILD_ID=$BUILD_ID
```

The ID lives in the image, so `smoke` proves which image is serving, and a promoted image reports the same ID in every environment. `smoke` fails unless it matches the build just deployed. A frontend's build command receives `BUILD_ID` too; the kit adds `/_turbo-vibe/build-id` to its output so `smoke` can check the page as well.

## Databases

A `supabase` database gets its own Supabase project per environment, with the Data API turned off:

```yaml
  db:
    kind: database
    target: supabase
    organization: your-org-slug   # Organization Settings → Organization slug
    region: eu-central-1
    plan: free                    # or paid
    staging: project              # or branch: staging as a persistent branch of production (paid plans only; apply production first)
    workdir: .                    # the directory holding supabase/migrations
```

`migrate` creates two roles in each database: `turbo_vibe_migrator`, which owns the schema and runs `supabase db push`, and `turbo_vibe_runtime`, which can read and write rows but cannot change the schema. Both connect through the Supabase session pooler (IPv4). A paused free-plan project is reported as paused. A failed migration stops the run before anything deploys. `deploy` gives every backend the runtime role's connection as the secret environment variable `DATABASE_URL` (session pooler, never the transaction pooler); it reads it from the environment's OpenTofu state, so a project with a database needs the state variables for `deploy` too. Write migrations forward-only, expand then contract, so the previous backend keeps working while the new one deploys.

## Static frontends on Vercel (beta)

A `vercel-static` frontend gets a Vercel project per environment, named `<project>-<service>-<environment>`, on that environment's hostname. A DNS-only CNAME in the Cloudflare zone points the hostname at Vercel. `deploy` runs the frontend's build in CI, then ships the files as a prebuilt output (`vercel deploy --prebuilt`), so Vercel never receives or builds the source. Promotion ships the same recorded files to the production project.

```yaml
  web:
    kind: frontend
    target: vercel-static
    build: { command: "pnpm build", output: dist }
```

With a backend in the same project, the two run on different hosts. The frontend keeps the environment's hostname, and the backend moves to its API hostname: `api.<hostname>` by default, or `environments.<env>.api_hostname`. Set it explicitly when `api.<hostname>` would be two levels below the zone, which Universal SSL does not cover. It must sit under the frontend hostname's parent domain, so the two can share sign-in cookies. validation rejects anything else, except one case it cannot detect without a public-suffix list: a frontend directly under a public suffix such as `co.uk` (`example.co.uk` with `api.other.co.uk`). Use `api.example.co.uk` there. The kit then gives each side what the other needs, per environment:

- The backend receives `ALLOWED_ORIGINS`, set to exactly that environment's frontend URL and never a wildcard. It also receives `FRONTEND_URL`, and `COOKIE_DOMAIN`, the domain both hosts share. It must refuse any other origin. The example does this in `examples/go-api/cors.go`. When staging and production hosts sit in the same zone, `COOKIE_DOMAIN` is the same for both, so give the session cookie a name unique to the environment, or one would overwrite the other. The example derives it from the environment's signing key.
- The page reads `/_turbo-vibe/config.json`, which `deploy` writes next to the built files for each environment: `{ "apiUrl": "https://api…" }`. The build stays identical, so promotion still ships the staging files unchanged. The Vercel project also gets `TURBO_VIBE_API_URL`.

```yaml
environments:
  staging: { hostname: staging-app.example.com, api_hostname: api-staging-app.example.com }
  production: { api_hostname: api-app.example.com }
```

`examples/vercel-static` deploys the example's page to Vercel and its API to Cloudflare.

## Next.js on Vercel (beta)

A `vercel-nextjs` frontend is built in CI with `vercel build --prod`, which uses Vercel's build output format. Server-rendered pages and route handlers become Vercel functions. The kit ships that output prebuilt, records it, and promotes the same output to production without building again.

```yaml
  web:
    kind: frontend
    target: vercel-nextjs
    build:
      command: npm ci      # runs in root before `vercel build`
      root: web            # the Next.js app; defaults to the config's directory
```

The build receives `BUILD_ID` and no kit credentials. To show it on a page, inline it at build time, as `examples/nextjs/next.config.mjs` does. A value read at request time would describe the environment, not the build. The kit adds `/_turbo-vibe/build-id` to the output for `smoke`. During the build it puts a temporary `.vercel/project.json` in `root`, and restores yours afterwards if you have run `vercel link` there. With a backend in the project, the app gets `TURBO_VIBE_API_URL` as a Vercel environment variable at runtime, as `vercel-static` does.

## Sign-in

A `workos` identity service registers each environment's callback as a WorkOS redirect URI, in the WorkOS environment whose key the run uses: the staging key for staging, the production key for production.

```yaml
  auth:
    kind: identity
    target: workos
    callback_path: /api/auth/callback   # the default; must be under /api/
```

`apply` first lists the environment's redirect URIs through the WorkOS API. A callback already registered by hand counts as registered and is left alone; URIs the kit did not create are never removed.

`deploy` gives every backend `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, and `WORKOS_REDIRECT_URI` (the environment's callback) as secrets. Frontend build commands run without any of the kit's credentials in their environment, so none can end up in a public bundle. The example in `examples/go-api` signs users in with AuthKit: `/api/auth/login`, `/api/auth/callback`, and `/api/me`.

## Credentials

`apply` and `deploy` read these environment variables and stop, naming any that are missing, before they run anything (`deploy` needs the `CLOUDFLARE_*` ones, plus the state ones, the `WORKOS_*` ones when it has an identity service, and the `VERCEL_*` ones when it has a Vercel frontend):

| Variable | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with Workers Scripts: Edit and Containers: Edit (account), Workers Routes: Edit and DNS: Edit (zone), User → API Tokens: Read so `check` can confirm the token's own permissions, and, with a container backend, Account → Billing: Read so `check` can confirm the Workers Paid plan |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account that runs the Workers and holds the state bucket |
| `CLOUDFLARE_ZONE_ID` | the zone of the project's `domain` |
| `TURBO_VIBE_STATE_BUCKET` | an R2 bucket for OpenTofu state, created once by hand |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | an R2 API token with Object Read & Write on that bucket |
| `SUPABASE_ACCESS_TOKEN` | a Supabase personal access token, for projects with a `supabase` database (`apply` and `migrate`) |
| `SUPABASE_ORGANIZATION` | the Supabase organization's slug, when the database leaves `organization` out of `turbo-vibe.yaml` (`apply`) |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` | the WorkOS environment's API key and client ID; set the staging ones on the `staging` GitHub environment and the production ones on `production` (`apply` and `deploy`) |
| `VERCEL_API_TOKEN`, `VERCEL_TEAM_ID` | a Vercel access token and the team (or personal account) ID, for `vercel-static` frontends (`apply` and `deploy`) |

OpenTofu 1.10 or later must be on `PATH` as `tofu`. Docker must be available to `deploy`, which builds container images. Add `.turbo-vibe/` to the project's `.gitignore`; `apply` and `deploy` write their working files there.
