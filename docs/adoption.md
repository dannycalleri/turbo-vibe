# Adopting turbo-vibe in an existing project

turbo-vibe is the production step after the prototype: a staging copy and a production copy, the build tested on staging promoted unchanged, and a person approving the switch. Everything it creates lives in your own accounts. This guide takes a repository that already has a backend with a Dockerfile, and optionally a single-page app, to "merge deploys staging, one approved click deploys production". Follow it in order: each step names what you should see before moving on.

A static site, or an app whose server already meets the backend contract, needs only `npx @turbo-vibe/cli@1 init`. This guide is for a backend that must change to fit.

**With a coding assistant:** run `npx @turbo-vibe/cli@1 adopt` at the repository root. It writes guidance for the assistants the repository already uses, or for those you name with `--assistant claude`, `cursor` or `claude,cursor`, then ask the assistant to make the project deployable with turbo-vibe. It follows the steps below, checks the result locally, and stops before anything that needs your accounts. The rest of this guide is the same work by hand.

## 1. Check the backend

turbo-vibe adapts to most servers. Check four things:

- Listen on `0.0.0.0`, on the port in the Dockerfile's `EXPOSE`. Without `EXPOSE`, set `container.port` in `turbo-vibe.yaml`; without either, the port is 8080. The kit also sets `PORT`.
- Know the backend's path prefixes. By default only `/api/*` reaches the backend. When its routes are elsewhere, set `paths` in `turbo-vibe.yaml` to the prefixes it uses, such as `[/v1/, /auth/]`, or `[/]` when no frontend shares its hostname. Every other path is the frontend's, or answers nothing.
- Exit on `SIGTERM`. Every deploy after the first replaces the running container: Cloudflare sends `SIGTERM` and waits up to 15 minutes before killing one that ignores it, and the deploy waits for that. A process running as the container's PID 1 ignores `SIGTERM` unless it handles it: Go servers exit by default, but Python and Node need a handler (or an init such as `tini` as the entrypoint).
- Start without the database. The pull request's dry run starts the image with no `DATABASE_URL`.

The backend needs no health route and no Dockerfile lines for turbo-vibe. After every deploy, the kit checks that the server answers `/` below HTTP 500, so a 404 passes. If the app has a readiness route that answers without the database, such as `/healthz`, set `container.health` to it in step 2; then only HTTP 2xx passes. The container receives the build ID as `TURBO_VIBE_BUILD_ID`, if the app wants to show it.

Check: once `turbo-vibe.yaml` exists (step 2), `npx @turbo-vibe/cli@1 deploy --env staging --build-id local --dry-run` builds the image, starts it, and fails unless the server answers on its port and the container stops on `SIGTERM`. By hand: `docker build -t app . && docker run -p 3000:3000 -e PORT=3000 app` with your port in place of 3000, then `curl -i localhost:3000/` → any status below 500. `docker stop` should return at once, not after its 10-second timeout.

## 2. Add `turbo-vibe.yaml`

`npx @turbo-vibe/cli@1 init` writes this file and the two workflows in step 3, and never overwrites existing files. It asks with arrow-key choices and offers defaults it reads from the repository: the name from `package.json`, a backend for a `Dockerfile`, a frontend for a `next` dependency or a `build` script, a database for a `supabase/` folder. Adjust the build commands it leaves as defaults. It then offers to run `setup`: answer yes once the accounts and tokens of step 4 exist, otherwise answer no and run `setup` at step 4. To write the files by hand instead:

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

Leave out `web` if there is no frontend. If the frontend runs on Vercel (`target: vercel-static`), the backend moves to its own API hostname. In that case, follow the reference's [Static frontends on Vercel](reference.md#static-frontends-on-vercel-beta): set `api_hostname` per environment, make the backend refuse origins other than `ALLOWED_ORIGINS`, and have the page read its API URL from `/_turbo-vibe/config.json`. Add `db` (`target: supabase`) and `auth` (`target: workos`) as described in the [reference](reference.md#databases) when you need them.

Cloudflare's free certificate covers the apex and names one level below it. `staging.myapp.example.com` is two levels below `example.com` and would fail TLS. That is why the example sets `staging-myapp.example.com` instead.

Check: `npx @turbo-vibe/cli@1 plan` → staging and production, each listing `api` at `/api/` and `web` at `/`.

`init` adds `.turbo-vibe/` to `.gitignore`. If you wrote the files by hand, add it yourself.

### The application's own values

List the values the application reads, by kind, so that `setup` asks for them and each environment gets its own:

```yaml
  api:
    kind: backend
    secrets: [STRIPE_SECRET_KEY]            # read at run time; one value per environment
    build:
      dockerfile: Dockerfile
      secrets: [NPM_TOKEN]                  # only the build needs it; one value for the repository
  web:
    kind: frontend
    public: [VITE_STRIPE_PUBLISHABLE_KEY]   # inlined by the build; one value per environment
```

- A `public` value must be an identifier, a key or a DSN, never a switch the build compares: during the build the code sees a placeholder, which each deploy replaces.
- A Next.js page that reads a runtime secret must render per request: it calls `cookies()`, `headers()` or `connection()`, or exports `dynamic = "force-dynamic"`. A page rendered during the build sees no secret.
- The kit sets some names itself, so validation refuses them and suggests a prefixed one, such as `APP_AWS_ACCESS_KEY_ID`. The reference's [Your application's own secrets](reference.md#your-applications-own-secrets), [Public values in a frontend build](reference.md#public-values-in-a-frontend-build) and [Secrets only the build needs](reference.md#secrets-only-the-build-needs) say how each kind travels.

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
  production:
    needs: deploy
    if: vars.TURBO_VIBE_PROMOTE_FROM_STAGING == 'true' && github.event_name == 'push' && github.ref == 'refs/heads/main'
    uses: dannycalleri/turbo-vibe/.github/workflows/promote.yml@v1
    with:
      confirm-build: ${{ github.sha }}
      require-reviewer: true
      allow-deletions: ${{ inputs.allow-deletions == true }}
    secrets: inherit
```

The `production` job promotes the run's own build after a reviewer of the `production` environment approves it. It runs only when the repository variable `TURBO_VIBE_PROMOTE_FROM_STAGING` is `true`, which `setup` sets when it adds you as a required reviewer. A repository that already had a reviewer sets it once: `gh variable set TURBO_VIBE_PROMOTE_FROM_STAGING --body true`.

`.github/workflows/production.yml`:

```yaml
name: Deploy to production
on:
  workflow_dispatch:
    inputs:
      confirm-build:
        description: "Empty: the newest build that passed staging, where production has a required reviewer. An older build's ID: a rollback"
        type: string
        default: ""
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

Pull requests run the test-and-build job without any GitHub environment: a pull request from a fork gets no secrets at all, and one from a branch of this repository gets only the repository's build secrets (`build.secrets`), for its dry run. Only `main` deploys staging: on every push, or when a maintainer runs **Staging** by hand. `setup` limits the `staging` and `production` environments to `main`, where GitHub offers deployment-branch rules (public repositories, and private ones on GitHub Pro, Team or Enterprise).

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

Previews run in the `preview` GitHub environment, with its own state bucket and tokens, which `setup` creates when the config enables previews. Pull request code receives those, never the `staging` or `production` environments' secrets. Some tokens still reach further than the preview: the Supabase and Vercel tokens cover the whole account or team, the WorkOS key is the one of WorkOS's staging environment, and within one Cloudflare account the preview's token can still change production's Workers and DNS records. The bootstrap checklist's [What one account leaves shared](bootstrap.md#8-what-one-account-leaves-shared) lists every such limit. A project with a database needs Supabase's paid plan for previews, because each preview gets its own database branch.

## 4. Create the accounts, tokens, and GitHub environments

Do this once per project. The [bootstrap checklist](bootstrap.md) walks through every step and the plan it needs; this is the short version. The reference's [Credentials](reference.md#credentials) table says which command reads each one.

1. **Accounts and plans:** the domain registered, and a Cloudflare account, with Workers Paid for Containers and R2 enabled. Add the Supabase organization, WorkOS workspace and Vercel team that your targets need.
2. **Tokens that only you can create:** a Cloudflare bootstrap token with *Account API Tokens: Edit*, a Supabase access token, each WorkOS environment's API key and client ID, and a Vercel access token, as your targets need them.
3. **Run `setup`** in a terminal, with the [GitHub CLI](https://cli.github.com) signed in:

   ```sh
   npx @turbo-vibe/cli@1 setup
   ```

   It creates `staging` and `production`, and `preview` when the config enables previews, limits `staging` and `production` to `main` and adds you as a required reviewer on `production` where your GitHub plan offers them, finds or creates the Cloudflare zone and a state bucket per environment, creates the per-environment tokens from the bootstrap token, and stores every secret in its environment. It ends with the checks. A `FAIL` on a value you entered is fixed with `setup --replace <SECRET>`; a plain second run asks only for what is missing.

## 5. Merge, then promote

1. Merge a change to `main`. The **Staging** run applies infrastructure, migrates, builds and pushes the image, deploys, and smoke-tests.
   Check: the staging hostname serves the app, and `/_turbo-vibe/health` on the **same hostname** reports the merged commit's SHA as `build_id`.
2. Open the Staging run, select **Review deployments** on its **production** job, and approve it. Without a required reviewer, copy the build ID from the Staging run's summary and run **Deploy to production** from the Actions tab with it as **confirm-build** instead. To roll back, run **Deploy to production** with the ID of an older build that passed staging; the reference's [Deploy to production](reference.md#deploy-to-production) says what a rollback cannot cross.
   Check: production's `/_turbo-vibe/health` reports the same SHA as staging. Nothing was rebuilt; the run's log has no `docker build`.

If staging's smoke test fails, the run fails and names both build IDs. That build can never be promoted.

## Cost

Public repositories run the workflows at no cost. For private repositories, the reference's [Actions minutes per run](reference.md#actions-minutes-per-run) table lists the expected minutes for a pull request, a merge, and a promotion.
