# turbo-vibe

Deploy a project's services from one `turbo-vibe.yaml`.

```sh
npx @turbo-vibe/cli plan
npx @turbo-vibe/cli test
npx @turbo-vibe/cli apply --env staging
npx @turbo-vibe/cli migrate --env staging
npx @turbo-vibe/cli deploy --env staging --build-id "$(git rev-parse --short HEAD)"
npx @turbo-vibe/cli smoke --env staging --build-id "$(git rev-parse --short HEAD)"
```

`deploy --dry-run` builds everything and validates the Worker without credentials.

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

`apply` and `deploy` read these environment variables and stop, naming any that are missing, before they run anything (`deploy` needs the `CLOUDFLARE_*` ones, plus the state ones when the project has a database and the `WORKOS_*` ones when it has an identity service):

| Variable | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with Workers Scripts: Edit and Containers: Edit (account), Workers Routes: Edit and DNS: Edit (zone) |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account that runs the Workers and holds the state bucket |
| `CLOUDFLARE_ZONE_ID` | the zone of the project's `domain` |
| `TURBO_VIBE_STATE_BUCKET` | an R2 bucket for OpenTofu state, created once by hand |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | an R2 API token with Object Read & Write on that bucket |
| `SUPABASE_ACCESS_TOKEN` | a Supabase personal access token, for projects with a `supabase` database (`apply` and `migrate`) |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` | the WorkOS environment's API key and client ID; set the staging ones on the `staging` GitHub environment and the production ones on `production` (`apply` and `deploy`) |

OpenTofu 1.10 or later must be on `PATH` as `tofu`. Docker must be available to `deploy`, which builds container images. Add `.turbo-vibe/` to the project's `.gitignore`; `apply` and `deploy` write their working files there.
