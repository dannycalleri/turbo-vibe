# Adopting turbo-vibe in an existing project

turbo-vibe is the production step after the prototype: a staging copy and a production copy, the build tested on staging promoted unchanged, and a person approving the switch. Everything it creates lives in your own accounts. This guide takes a repository that already has a backend with a Dockerfile, and optionally a single-page app, to "merge deploys staging, one approved click deploys production". Follow it in order: each step names what you should see before moving on.

## 1. Make the backend report its build

The smoke test after every deploy asks the backend which build it is running.

- Listen on port 8080 (the kit also sets `PORT`).
- Answer `GET /api/health` with JSON containing `build_id`:

  ```json
  { "build_id": "4f2c9e1…" }
  ```

- Take the value from the build argument the kit passes to `docker build`. Put this in the Dockerfile's **final** stage:

  ```dockerfile
  ARG BUILD_ID
  ENV BUILD_ID=$BUILD_ID
  ```

- Serve every backend route under `/api/`. When the frontend is served from the same Worker, only `/api/*` reaches the backend.

Check: `docker build --build-arg BUILD_ID=local -t app . && docker run -p 8080:8080 app`, then `curl localhost:8080/api/health` → `{"build_id":"local"}`.

## 2. Add `turbo-vibe.yaml`

`npx @turbo-vibe/cli@1 init` writes this file and the two workflows in step 3 from a few answers, and never overwrites existing files. Adjust the build commands it leaves as defaults. To write the files by hand instead:

At the repository root:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@turbo-vibe/cli@1/schema/turbo-vibe.schema.json
version: 1
project: myapp                 # lowercase; names Workers, state, and Supabase projects
domain: myapp.example.com      # production; staging defaults to staging.<domain>
environments:
  staging: { hostname: staging-myapp.example.com }   # keep it one level below the zone, see below
services:
  api:
    kind: backend
    target: cloudflare-container
    build:
      dockerfile: Dockerfile
      test: docker run --rm -v "$PWD":/src -w /src golang:1.27 go test ./...   # any command; runs on the CI runner
  web:
    kind: frontend
    target: cloudflare-static
    serve_with: api            # one Worker: the app at /, the API at /api/
    build:
      command: pnpm --dir web build
      output: web/dist
      test: pnpm --dir web test
```

Leave out `web` if there is no frontend. If the frontend runs on Vercel (`target: vercel-static`), the backend moves to its own API hostname. In that case, follow the README's [Static frontends on Vercel](../README.md#static-frontends-on-vercel-beta): set `api_hostname` per environment, make the backend refuse origins other than `ALLOWED_ORIGINS`, and have the page read its API URL from `/_turbo-vibe/config.json`. Add `db` (`target: supabase`) and `auth` (`target: workos`) as described in the [README](../README.md#databases) when you need them.

Cloudflare's free certificate covers the apex and names one level below it. `staging.myapp.example.com` is two levels below `example.com` and would fail TLS. That is why the example sets `staging-myapp.example.com` instead.

Check: `npx @turbo-vibe/cli@1 plan` → staging and production, each listing `api` at `/api/` and `web` at `/`.

Add `.turbo-vibe/` to `.gitignore`.

## 3. Add the two workflows

`.github/workflows/staging.yml`:

```yaml
name: Staging
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
      allow-deletions: ${{ inputs.allow-deletions == true }}
    secrets: inherit
```

`.github/workflows/production.yml`:

```yaml
name: Deploy to production
on:
  workflow_dispatch:
    inputs:
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
      allow-deletions: ${{ inputs.allow-deletions == true }}
    secrets: inherit
```

Pass `with: { config: path/to/turbo-vibe.yaml }` if the file is not at the root. The `@v1` tag and the CLI version move together, so a workflow tag always runs the CLI it was released with.

Pull requests, including from forks, run the test-and-build job with no secrets. Only `main` deploys: on every push, or when a maintainer runs **Staging** by hand.

`apply` refuses to delete or replace a resource unless told to, so removing or renaming a service, or a change that forces a resource to be recreated, stops the run before anything changes. The log names each resource. If the deletion is intended, run the workflow again from the Actions tab on `main` with **allow-deletions** ticked. Locally, `turbo-vibe plan --env staging` shows the same list before you merge.

To give each pull request its own preview, set `previews: true` in `turbo-vibe.yaml` and add `.github/workflows/previews.yml`:

```yaml
name: Previews
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
permissions:
  contents: read
  pull-requests: write
jobs:
  preview:
    uses: dannycalleri/turbo-vibe/.github/workflows/preview.yml@v1
    secrets: inherit
```

A project with a database needs Supabase's paid plan for previews, because each preview gets its own database branch.

## 4. Create the accounts, tokens, and GitHub environments

Do this once per project. The [bootstrap checklist](bootstrap.md) walks through every step and the plan it needs; this is the short version. The README's [Credentials](../README.md#credentials) table says which command reads each one. When you are done, `npx @turbo-vibe/cli@1 check --env staging` names anything still missing.

1. **Cloudflare:** the domain's zone on Cloudflare, and the Workers Paid plan (required for Containers).
   - An API token with *Workers Scripts: Edit*, *Containers: Edit*, *Workers Routes: Edit* and *DNS: Edit* on the zone.
   - An R2 bucket for state and build records, plus an R2 API token with *Object Read & Write* on it.
2. **GitHub → Settings → Environments:** create `staging` and `production`. On `production`, add required reviewers; that is the approval step. Give each environment these secrets, using that environment's values:
   - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`
   - `TURBO_VIBE_STATE_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (the R2 token)
   - with a database: `SUPABASE_ACCESS_TOKEN`
   - with sign-in: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` (the staging environment's keys on `staging`, the production keys on `production`)
   - with a `vercel-static` frontend: `VERCEL_API_TOKEN`, `VERCEL_TEAM_ID`

## 5. Merge, then promote

1. Merge a change to `main`. The **Staging** run applies infrastructure, migrates, builds and pushes the image, deploys, and smoke-tests.
   Check: the staging hostname serves the app, and `/api/health` on the **same hostname** reports the merged commit's SHA.
2. Run **Deploy to production** from the Actions tab and approve it.
   Check: production's `/api/health` reports the same SHA as staging. Nothing was rebuilt; the run's log has no `docker build`.

If staging's smoke test fails, the run fails and names both build IDs. That build can never be promoted.

## Cost

Public repositories run the workflows at no cost. For private repositories, the README's [Actions minutes per run](../README.md#actions-minutes-per-run) table lists the expected minutes for a pull request, a merge, and a promotion.
