# turbo-vibe

Deploy a project's services from one `turbo-vibe.yaml`. To add it to an existing repository, follow the [adoption guide](docs/adoption.md).

```sh
npx @turbo-vibe/cli plan
npx @turbo-vibe/cli test
npx @turbo-vibe/cli apply --env staging
npx @turbo-vibe/cli migrate --env staging
npx @turbo-vibe/cli deploy --env staging --build-id "$(git rev-parse --short HEAD)"
npx @turbo-vibe/cli smoke --env staging --build-id "$(git rev-parse --short HEAD)"
npx @turbo-vibe/cli promote --env production
```

`deploy --dry-run` builds everything and validates the Worker without credentials.

## Build once, promote the same build

A staging `deploy` builds every service once and records what it shipped in the state bucket, at `<project>/builds/<build id>.json`:
- the container image's registry digest (`docker build`, then `wrangler containers push`);
- an archive of each static frontend's built files.

`smoke --env staging` marks that record `passed` or `failed`.

`promote --env production` picks the newest staging build that passed. Newer failed or unchecked builds are skipped. It deploys only that build's recorded outputs: the same image digest, and the same files unpacked from the archive. Nothing is built again. With no passing build, it stops before changing anything. `promote --choose` prints the build it would promote and changes nothing. `promote --build-id <id>` promotes exactly that build, and refuses it unless it passed on staging. Use the two together to migrate production from the chosen build's commit before deploying it. `deploy --env production` is refused, so production only ever runs promoted builds.

## Deploy to production

The reusable `promote.yml` workflow is the "Deploy to production" button: call it from a `workflow_dispatch` workflow, the way `.github/workflows/production.yml` does for the kit's example. Its job runs in the GitHub environment `production`. Give that environment required reviewers once (Settings → Environments), and every run waits for an approval before any production secret is used. It then:

1. chooses the latest staging build that passed (`promote --choose`);
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

## Static frontends on Vercel

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
| `CLOUDFLARE_API_TOKEN` | API token with Workers Scripts: Edit and Containers: Edit (account), Workers Routes: Edit and DNS: Edit (zone) |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account that runs the Workers and holds the state bucket |
| `CLOUDFLARE_ZONE_ID` | the zone of the project's `domain` |
| `TURBO_VIBE_STATE_BUCKET` | an R2 bucket for OpenTofu state, created once by hand |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | an R2 API token with Object Read & Write on that bucket |
| `SUPABASE_ACCESS_TOKEN` | a Supabase personal access token, for projects with a `supabase` database (`apply` and `migrate`) |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` | the WorkOS environment's API key and client ID; set the staging ones on the `staging` GitHub environment and the production ones on `production` (`apply` and `deploy`) |
| `VERCEL_API_TOKEN`, `VERCEL_TEAM_ID` | a Vercel access token and the team (or personal account) ID, for `vercel-static` frontends (`apply` and `deploy`) |

OpenTofu 1.10 or later must be on `PATH` as `tofu`. Docker must be available to `deploy`, which builds container images. Add `.turbo-vibe/` to the project's `.gitignore`; `apply` and `deploy` write their working files there.
