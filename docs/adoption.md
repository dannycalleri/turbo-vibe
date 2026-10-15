# Adopting turbo-vibe in an existing project

turbo-vibe is the production step after the prototype: a staging copy and a production copy, the build tested on staging promoted unchanged, and a person approving the switch. Everything it creates lives in your own accounts. This guide takes a repository that already has a backend with a Dockerfile, and optionally a single-page app, to "merge deploys staging, one approved click deploys production". Follow it in order: each step names what you should see before moving on.

**With a coding assistant:** run `npx @turbo-vibe/cli@1 adopt --assistant claude` at the repository root (`cursor` or `both` for the others; `@next` while only release candidates are published), then ask the assistant to make the project deployable with turbo-vibe. It follows the steps below, checks the result locally, and stops before anything that needs your accounts. The rest of this guide is the same work by hand.

## 1. Make the backend report its build

The smoke test after every deploy asks the backend which build it is running.

- Listen on port 8080 (the kit also sets `PORT`).
- Answer `GET /api/health` with JSON containing `build_id`, without touching the database: the pull request's dry run starts the image with no `DATABASE_URL`, and staging checks it while a paused database wakes:

  ```json
  { "build_id": "4f2c9e1…" }
  ```

- Take the value from the build argument the kit passes to `docker build`. Put this in the Dockerfile's **final** stage:

  ```dockerfile
  ARG BUILD_ID
  ENV BUILD_ID=$BUILD_ID
  ```

- Serve every backend route under `/api/`. Only `/api/*` reaches the backend, with or without a frontend; every other path is the frontend's, or answers nothing.
- Exit on `SIGTERM`. Every deploy after the first replaces the running container: Cloudflare sends `SIGTERM` and waits up to 15 minutes before killing one that ignores it, and the deploy waits for that. A process running as the container's PID 1 ignores `SIGTERM` unless it handles it: Go servers exit by default, but Python and Node need a handler (or an init such as `tini` as the entrypoint). The test-and-build job checks this on every pull request, with the health route: its dry run starts the image, and fails unless `/api/health` reports the build ID and `docker stop` stops it without killing it.

Check: once `turbo-vibe.yaml` exists (step 2), `npx @turbo-vibe/cli@1 deploy --env staging --build-id local --dry-run` builds the image, starts it, and fails unless `/api/health` reports `local` and the container stops on `SIGTERM`. By hand: `docker build --build-arg BUILD_ID=local -t app . && docker run -p 8080:8080 app`, then `curl localhost:8080/api/health` → JSON whose `build_id` is `local`. `docker stop` should return at once, not after its 10-second timeout.

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
      command: npm --prefix web ci && npm --prefix web run build
      output: web/dist
      test: npm --prefix web ci && npm --prefix web test   # runs first on a fresh CI runner, so it installs; for pnpm, start with `corepack enable &&`
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
      confirm-build: ${{ inputs.confirm-build }}
      allow-deletions: ${{ inputs.allow-deletions == true }}
    secrets: inherit
```

Pass `with: { config: path/to/turbo-vibe.yaml }` if the file is not at the root. The `@v1` tag and the CLI version move together, so a workflow tag always runs the CLI it was released with.

Pull requests, including from forks, run the test-and-build job with no secrets. Only `main` deploys staging: on every push, or when a maintainer runs **Staging** by hand. `setup` limits the `staging` and `production` environments to `main`, where GitHub offers deployment-branch rules (public repositories, and private ones on GitHub Pro, Team or Enterprise).

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

Previews run in the `preview` GitHub environment, with its own state bucket and tokens, which `setup` creates when the config enables previews. Pull request code receives those, never the `staging` or `production` environments' secrets. Some tokens still reach further than the preview: the Supabase and Vercel tokens cover the whole account or team, the WorkOS key is the one of WorkOS's staging environment, and within one Cloudflare account the preview's token can still change production's Workers and DNS records. The bootstrap checklist's [What one account leaves shared](bootstrap.md#7-what-one-account-leaves-shared) lists every such limit. A project with a database needs Supabase's paid plan for previews, because each preview gets its own database branch.

## 4. Create the accounts, tokens, and GitHub environments

Do this once per project. The [bootstrap checklist](bootstrap.md) walks through every step and the plan it needs; this is the short version. The README's [Credentials](../README.md#credentials) table says which command reads each one.

1. **Accounts and plans:** the domain registered, and a Cloudflare account, with Workers Paid for Containers and R2 enabled. Add the Supabase organization, WorkOS workspace and Vercel team that your targets need.
2. **Tokens that only you can create:** a Cloudflare bootstrap token with *Account API Tokens: Edit*, a Supabase access token, each WorkOS environment's API key and client ID, and a Vercel access token, as your targets need them.
3. **Run `setup`** in a terminal, with the [GitHub CLI](https://cli.github.com) signed in:

   ```sh
   npx @turbo-vibe/cli@1 setup
   ```

   It creates `staging` and `production`, and `preview` when the config enables previews, limits `staging` and `production` to `main` and adds you as a required reviewer on `production` where your GitHub plan offers them, finds or creates the Cloudflare zone and a state bucket per environment, creates the per-environment tokens from the bootstrap token, and stores every secret in its environment. It ends with the checks. A `FAIL` on a value you entered is fixed with `setup --replace <SECRET>`; a plain second run asks only for what is missing.

## 5. Merge, then promote

1. Merge a change to `main`. The **Staging** run applies infrastructure, migrates, builds and pushes the image, deploys, and smoke-tests.
   Check: the staging hostname serves the app, and `/api/health` on the **same hostname** reports the merged commit's SHA.
2. Copy the build ID from the Staging run's summary, run **Deploy to production** from the Actions tab with it as **confirm-build**, and approve it if the `production` environment has reviewers.
   Check: production's `/api/health` reports the same SHA as staging. Nothing was rebuilt; the run's log has no `docker build`.

If staging's smoke test fails, the run fails and names both build IDs. That build can never be promoted.

## Cost

Public repositories run the workflows at no cost. For private repositories, the README's [Actions minutes per run](../README.md#actions-minutes-per-run) table lists the expected minutes for a pull request, a merge, and a promotion.
