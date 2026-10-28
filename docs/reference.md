# Reference

The details behind the [README](../README.md): what each command does, how a release travels, and what each target needs.

- [Commands in detail](#commands-in-detail)
- [Build once, promote the same build](#build-once-promote-the-same-build)
- [Deploy to production](#deploy-to-production)
- [Previews](#previews)
- [What a backend must do](#what-a-backend-must-do)
- [Sessions on their own container](#sessions-on-their-own-container)
- [Databases](#databases)
- [Sign-in](#sign-in)
- [Static frontends on Vercel (beta)](#static-frontends-on-vercel-beta)
- [Next.js on Vercel (beta)](#nextjs-on-vercel-beta)
- [Credentials](#credentials)
- [Your application's own secrets](#your-applications-own-secrets)
- [Public values in a frontend build](#public-values-in-a-frontend-build)
- [Secrets only the build needs](#secrets-only-the-build-needs)
- [Actions minutes per run](#actions-minutes-per-run)
- [Coding assistants](#coding-assistants)
- [Moving between hosts](#moving-between-hosts)

## Commands in detail

**`init`** asks for the project's name, domain, and the target of each service, with defaults read from the repository, then writes `turbo-vibe.yaml` and the staging and production workflows and adds `.turbo-vibe/` to `.gitignore`. In a terminal with a signed-in GitHub CLI, it then offers to run `setup`. It ends with the steps that remain: `setup` first when it did not run, and why; then the push to `main` and the promotion. It never replaces existing files unless given `--force`. Every answer has a flag (`--name`, `--domain`, `--backend`, `--frontend`, `--database`, `--identity`, `--assistant`) for running it non-interactively. It treats a two-label domain (`example.com`) as the zone apex and anything longer as one level below the zone. For a domain on a multi-part suffix, such as `example.co.uk`, edit the hostnames it writes. The frontend's install step follows the repository's lockfile: `npm ci`, `pnpm install --frozen-lockfile` through corepack, or `yarn install --frozen-lockfile`; without a lockfile, or for bun, which the CI runner lacks, `npm install`. Build commands, output directories and the Supabase region it fills in are marked as defaults to replace.

**`adopt`** writes guidance for coding assistants (`--assistant claude`, `cursor`, or a list such as `claude,cursor`; by default, the ones the repository already uses) into an existing repository, which needs no `turbo-vibe.yaml` yet. Asked to make the project deployable with turbo-vibe, the assistant inspects the repository, maps each part to a target or names what turbo-vibe cannot run yet, changes the backend to the contract in [What a backend must do](#what-a-backend-must-do), writes the config and workflows with `init`, checks them with `plan`, `test` and `deploy --dry-run`, and leaves account setup and production to you. It never replaces existing files unless given `--force`.

**`plan`** lists the services each environment runs and where, from the file alone. `plan --env <env>` asks OpenTofu what applying that environment would do and prints it per service: what it would create, change, replace or delete, with deletions and replacements listed apart. It prints resource addresses and actions only, never values, and changes nothing.

**`setup`** creates the GitHub environments `staging` and `production`, and `preview` when the config enables previews. It limits `staging` and `production` to `main` and adds you as a required reviewer on `production`, where GitHub offers these rules. It stores every secret each environment needs. From one Cloudflare bootstrap token, it finds or creates the zone and one state bucket per environment, and creates each environment's CI and R2 tokens. Each R2 token reaches only its environment's bucket; production's can also read staging's, to promote its builds. It finds the Supabase organization and the Vercel team from their tokens, and asks for the rest. It needs a terminal and a signed-in [GitHub CLI](https://cli.github.com): it reads each value without echoing it and gives it to `gh secret set` on standard input, so a value never reaches the disk, a command line or the output. A second run keeps what each environment already has. When every Cloudflare secret is kept, it asks "Add missing permissions to the Cloudflare CI tokens?": with yes and a bootstrap token, it adds the permissions a newer turbo-vibe or a new setting needs to each existing CI token, keeping its value. `--replace <SECRET>` asks for a secret again and creates its Cloudflare token again, and `--env <name>` sets up other environments, such as `live`, like `staging`. It ends with the checks that `check` runs. `setup --list` prints, from the file alone, the accounts, plans and steps a person must do first, and the secrets each environment will get; it changes nothing.

**`check`** verifies an environment's accounts, tokens, and tools for the targets the project uses, and changes nothing. It lists every problem with its fix, and exits non-zero until the environment is ready. For a frontend that installs with `npm ci`, it asks npm, without installing anything, whether the lockfile matches `package.json`, which the first staging run would otherwise find; production, which deploys staging's build, skips this.

**`apply`** writes the environment's OpenTofu root, saves a plan, prints its summary, and applies that plan. It refuses a plan that deletes or replaces a resource outside a preview unless given `--allow-deletions` (the reusable workflows' `allow-deletions` input).

**`deploy --dry-run`** builds everything and validates the Worker without credentials. It starts each backend image, and fails unless the container answers its health probe (`/` below HTTP 500, or HTTP 2xx from `container.health`) on its port and stops on `SIGTERM`. `deploy --env production` is refused, so production only ever runs promoted builds.

**`promote --choose`** prints the build it would promote and changes nothing. `promote --build-id <id>` promotes exactly that build, and refuses it unless it passed on staging. `promote --confirm <id>` chooses `<id>` when it passed staging, an older build being a rollback; with `--newest`, it refuses unless `<id>` is the newest build that passed.

**`ship`** is for a person at a terminal. It lists the last ten builds that passed staging, with the person's own signed-in `gh`, lets them choose one (the newest by default), asks to confirm and says when the build is a rollback, and starts the **Deploy to production** workflow with that build's ID. It prints the run's URL, where a required reviewer, if production has one, approves it. It never deploys anything itself. Without a terminal it needs `--build-id <sha>`, and says when that build is a rollback. `--allow-deletions` passes `allow-deletions` to the run. `--workflow <file>` names a production workflow other than `production.yml`. It lists builds and starts the run in the repository of the folder it runs in.

## Build once, promote the same build

A staging `deploy` builds every service once and records what it shipped in staging's state bucket, at `<project>/builds/<build id>.json`. Production reads those records from there and cannot change them:

- the container image's registry digest (`docker build`, then `wrangler containers push`);
- an archive of each static frontend's built files, with a placeholder where each [public value](#public-values-in-a-frontend-build) goes.

`smoke --env staging` marks that record `passed` or `failed`.

`promote --env production` picks the newest staging build that passed. Newer failed or unchecked builds are skipped. It deploys only that build's recorded outputs: the same image digest, and the same files unpacked from the archive. Nothing is built again. With no passing build, it stops before changing anything. `promote --choose` prints the build it would promote and changes nothing. `promote --build-id <id>` promotes exactly that build, and refuses it unless it passed on staging. Use the two together to migrate production from the chosen build's commit before deploying it. `promote --choose --confirm <id>` chooses that build when it passed staging, also when a newer build passed: that is a rollback. With `--newest`, it refuses any build but the newest that passed. `promote --describe [--build-id <id>]` prints, from GitHub's `staging` deployments, the build to promote, its commit subject and when it passed staging, and says when it is a rollback. It needs only a signed-in `gh` or `GITHUB_TOKEN`, and changes nothing. `deploy --env production` is refused, so production only ever runs promoted builds.

## Deploy to production

Production is promoted in one of two ways. Both run the reusable `promote.yml` in the GitHub environment `production`.

- **Approve the Staging run.** The Staging workflow that `init` writes has a `production` job. It runs on a push to `main` after staging passes, when the repository variable `TURBO_VIBE_PROMOTE_FROM_STAGING` is `true`. The job waits for a reviewer of the `production` environment: GitHub shows **Review deployments** on the run, in the notification and in the mobile app. The approval promotes that run's own build, so nobody types a build ID. `setup` sets the variable when it adds you as a required reviewer. Before it uses any secret, the job checks that `production` has a required reviewer, and stops when it has none, so the variable alone never deploys without an approval. When a newer build has passed staging, the approval of an older run stops before any change, and its summary names the newer build.
- **Deploy to production.** A `workflow_dispatch` workflow that calls `promote.yml`, the way `.github/workflows/production.yml` does for the kit's examples. It takes an optional `confirm-build`, the ID of the build to promote; each passing Staging run prints it in its summary. This is the way for a rollback, and the way where GitHub offers no required reviewers: on public repositories it offers them, and on private ones only with GitHub Enterprise.

| `confirm-build` | Required reviewer on `production` | Result |
|---|---|---|
| empty | yes | promotes the newest build that passed staging |
| empty | no | stops before any change; the summary names the newest build and asks for its ID |
| the newest build | either | promotes it |
| an older build that passed | either | promotes it; the summary calls it a rollback |
| a build that did not pass, or no record | either | stops before any change |

Before the approval, a first job with no secret writes the build to promote to the run's summary: the commit, its subject and when it passed staging, read from GitHub's `staging` deployments. The reviewer reads it before approving. The build records in the state bucket stay the authority: the production job promotes only a build that they show as passed, the newest one or the ID given. Without an ID, it promotes the build the summary named, and stops when a newer build passed while the run waited for the approval. `promote.yml` reads GitHub with `GITHUB_TOKEN` and asks for no permission beyond `contents: read`. Where GitHub does not list the deployments to that token, as on a private repository, the summary shows the commit's subject and date for a given ID, and cannot name the newest build for an empty one. There, pass the build ID to see the build before approving, or start the run with `turbo-vibe ship`, which lists the builds with your own `gh` login.

A rollback checks out the older commit and runs its migrations. Before `apply`, `migrate --check` compares the migrations the database has applied with the older commit's. When the database has one that the commit lacks, the run stops before any change and names the migration: a rollback cannot cross a migration. Fix forward instead: merge a change, and promote the build it makes.

A project set up before the Staging workflow had a `production` job adds the job from the [adoption guide](adoption.md#3-add-the-two-workflows), and, when `production` already has a reviewer, sets the variable once: `gh variable set TURBO_VIBE_PROMOTE_FROM_STAGING --body true`. To promote only with **Deploy to production**, delete the variable.

It then:

1. checks the reviewer rule, then chooses the build: the newest that passed, or the confirmed one (`promote --choose --confirm <id>`, with `--newest` for an approval from a Staging run);
2. checks out that build's commit, so production's infrastructure and migrations match the code being promoted;
3. runs `migrate --check`, then `apply`, then `migrate`, then `promote --build-id <id>` with the recorded image digests and asset archives, then `smoke`.

Nothing is built. Production's resources come from the same adapters as staging's: its own Worker routes and DNS on the project domain, its own Supabase project, and the callback registered in the WorkOS production environment with the production key.

## Previews

With `previews: true`, each pull request from a branch of the repository can get its own environment:

```sh
npx @turbo-vibe/cli@1 preview deploy --branch "$BRANCH" --build-id "$SHA"
npx @turbo-vibe/cli@1 preview remove --branch "$BRANCH"
```

- **Naming:** the preview is named after the branch, and its hostnames sit next to staging's. A branch that is already hostname-safe keeps its name: `feature-login` on `staging-shop.example.com` becomes `feature-login-staging-shop.example.com`. Any other name, or a long one, is normalized and given a short hash, so two branches never share a preview: `feature/login` becomes `feature-login-<6 hex>-staging-shop.example.com`.
- **Resources:** it has its own OpenTofu state, Workers, Vercel projects, and sign-in callback. The callback is registered in WorkOS's staging environment, because the `preview` GitHub environment holds an API key of that WorkOS environment.
- **Database:** a project with a database gets a Supabase branch, which needs a paid plan. On the free plan, `preview deploy` makes no preview and says why.
- **Removal:** `preview remove` deletes the preview's container application and destroys the preview's own state. It refuses to destroy anything that is not a preview.
- **Promotion:** preview builds are never recorded, so they cannot be promoted.

The reusable `preview.yml` workflow runs this for you on `pull_request` events: `opened`, `synchronize` and `reopened` deploy, `closed` removes. It runs in the `preview` GitHub environment, which `setup` creates with its own state bucket and tokens, so pull request code never receives the `staging` or `production` GitHub environments' secrets. Some tokens still reach further than the preview: the Supabase and Vercel tokens cover the whole account or team, the WorkOS key is the one of WorkOS's staging environment, and within one Cloudflare account the preview's token can still change production's Workers and DNS records. The bootstrap checklist's [What one account leaves shared](bootstrap.md#8-what-one-account-leaves-shared) lists every such limit. It posts the preview's URLs (or the reason there is none) as a comment on the pull request: a page at its root, and a backend with no page on its hostname at `/_turbo-vibe/health`, which reports the build it runs. A pull request from a fork gets no preview, because its run receives no secrets, and the run says so. `.github/workflows/previews.yml` previews the kit's Python and Vercel examples.

## HTTPS only

Cloudflare also answers on port 80. So when a Worker serves a hostname, `apply` for staging and production turns on the zone's **Always Use HTTPS** setting. Cloudflare then redirects each `http://` request to `https://` before a Worker receives it.

- The setting covers the whole zone. A hostname in the zone that turbo-vibe does not deploy also redirects.
- Previews never manage the setting, and the preview CI token has no Zone Settings: Edit. Pull-request code runs with that token, so it cannot change zone-wide settings.
- When the setting leaves the state, Cloudflare keeps it on. To turn it off, use the zone's SSL/TLS → Edge Certificates page.

A project set up before this setting existed lacks Zone Settings: Edit. Run `setup` once and answer y to "Add missing permissions to the Cloudflare CI tokens?": it adds the permission to each environment's CI token, keeping its value. Until then, `apply` for staging and production fails on the zone setting, and `check` names the missing permission.

## Private environments

An environment with `access.emails` is private. You write the list once, and the kit chooses the gate for each hostname: Cloudflare Access for a hostname that Cloudflare serves, and Vercel Authentication for a hostname that Vercel serves ([On Vercel](#on-vercel) below). A preview uses the `access` of staging.

On a hostname that Cloudflare serves, only the listed people get in:

1. A person opens the environment's hostname.
2. Cloudflare Access asks for an email address, and sends a one-time code to a listed address.
3. After the person enters the code, the page loads. The session lasts 24 hours.

`apply` creates one Access application on the project's zone for all of the environment's Cloudflare hostnames, with a policy for the people. A second application lets everyone through on the two paths the smoke test reads, `/_turbo-vibe/build-id` and `/_turbo-vibe/health`. Thus on a private environment those two paths are public, and every other path asks for the one-time code. The smoke test needs no Access credential.

Access needs Zero Trust on the account. A project with no service on a Cloudflare target needs no Zero Trust. Enable it once:

1. Open the [Zero Trust dashboard](https://one.dash.cloudflare.com/).
2. Choose a team name.
3. Choose the Free plan. Cloudflare asks for payment details, but it does not charge for the Free plan.

`setup --list` names this step for when Zero Trust is not on yet, and `check` fails until it is done. Every CI token that `setup` creates has Access: Apps and Policies: Edit on the project's zone, whether an environment is private or not, so making one private needs no new token. A token created by an older turbo-vibe lacks it: run `setup` once and answer y to "Add missing permissions to the Cloudflare CI tokens?". It adds the permission to the same token, so nothing is stored again. It updates only the environments that run handles: for one that `setup --env` set up, such as `live`, run `setup --env live` and answer y as well. Until then, `apply` fails on the Access resources, and `check` names the missing permission.

An environment that was private with turbo-vibe 1.0 keeps its Access resources on the account: one application, two account policies, and a service token, which `smoke` sends as `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Upgrading changes nothing for it, and its two probe paths stay private. A new preview of such a staging gets the same resources when its CI token reaches Access on the account only. To move the environment to the zone, remove its `access`, run its workflow once with `allow-deletions`, and add `access` again.

### On Vercel

For a private environment, `apply` sets Vercel Authentication on the "All Deployments" scope on each Vercel project of the environment. The scope covers the environment's own hostname too, not only the `*.vercel.app` URLs. It is free on every Vercel plan. A person who is not signed in to Vercel, or who has no access to the project, gets Vercel's sign-in page instead of the app.

For an environment without `access`, `apply` sets Standard Protection, Vercel's default for a new project: the environment's hostname is public, and the generated `*.vercel.app` URLs ask for a Vercel sign-in. Thus a public environment keeps the protection it had.

Vercel Authentication has no list of addresses. These people get in:

- every member of the Vercel team in `VERCEL_TEAM_ID`;
- a Vercel user whose access request a member approved;
- anyone with a shareable link that a member created.

Thus on Vercel, `access.emails` names the people who must get in. Give each listed person a Vercel account and a place in the team. The kit never invites anybody. On the Hobby plan, the team has one member, and only one outside person can get in, through an access request.

A frontend on `vercel-static` or `vercel-nextjs` beside a backend on a Cloudflare target cannot be private yet: the page calls the backend from another origin, and validation refuses `access` for that layout.

#### The bypass secret for the smoke test

For a private environment, `apply` also creates a protection bypass for automation on each Vercel project. `apply` chooses its secret, 32 random letters and digits, and keeps it on later runs. It does not let Vercel choose one, because OpenTofu prints each resource's ID and the bypass's ID holds its secret. The secret is in the OpenTofu state, in the environment's state bucket, as the sensitive output `vercel_protection_bypass`, beside the other credentials of the state. `smoke` sends it as `x-vercel-protection-bypass` to read `/_turbo-vibe/build-id`, so the smoke test and promotion work on a private environment. In GitHub Actions, `apply`, `smoke` and a preview's removal mask the secret before OpenTofu or the command writes any other line, so the log shows `***` in its place. When the outputs hold no secret for a project, `smoke` fails and asks for `apply`.

The secret opens every page of the project, not only the build ID. Vercel also gives it to each deployment of the project as `VERCEL_AUTOMATION_BYPASS_SECRET`, so server code of a `vercel-nextjs` app can read it: an app must never return its environment variables. To replace a leaked secret, remove `access` from the environment and add it again, each time through the environment's workflow (the removal with `allow-deletions`). Between the two runs, the environment is public.

### Shutting a person out

A Cloudflare Access session lasts 24 hours, and the kit cannot end one early. To shut a person out at once:

1. When the environment has a Vercel service: remove them from the Vercel team, revoke their approved access request in the Vercel project's settings, and revoke every shareable link of the project that they may hold.
2. Remove their address from `access.emails`, and apply.
3. In the [Zero Trust dashboard](https://one.dash.cloudflare.com/), revoke the person's sessions under Users, when the environment has a Cloudflare service.

### Making an environment public again

Removing `access` deletes resources: the Access applications on Cloudflare, and the bypass of each Vercel project, which returns to Standard Protection. `apply` refuses deletions, so run the environment's workflow once with `allow-deletions`, or pass `--allow-deletions` to `apply`.

### Search engines index only production

Every deploy of a `cloudflare-static` frontend outside production adds `X-Robots-Tag: noindex` to every page, whether the environment is private or not. The deploy copies the built site to `.turbo-vibe/wrangler/<environment>/<service>-site` and appends the rule to the copy's `_headers` file, after any rules the build has. It never changes the build output folder, and it makes the copy after the build is archived. Thus `promote` ships production the build without the rule. Vercel frontends do not get the rule, because Vercel serves `_headers` as a public file.

## Analytics

An environment with `analytics: true` counts visits with [Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/). It is free, and it sets no cookies.

- `apply` creates a Web Analytics site for the environment's hostname, and outputs the site token.
- Each deploy and each `promote` adds Cloudflare's beacon script before the last `</body>` of each page of a `cloudflare-static` frontend. A page is a file whose name ends in `.html` or `.htm`, in any letter case. The deploy changes only this environment's copy of the site (`.turbo-vibe/wrangler/<environment>/<service>-site`), after the build is archived. Thus the recorded build has no beacon, and an environment without `analytics` counts nothing.
- The deploy does not change a file without `</body>`, a file that is not UTF-8, or a page that already loads the beacon.
- Previews never count visits.
- When the environment counts visits and its outputs have no site token, `deploy` and `promote` stop and tell you to run `apply`.

The numbers are in the Cloudflare dashboard, under Analytics & Logs → Web Analytics. A Content Security Policy must allow `https://static.cloudflareinsights.com` in `script-src` and `https://cloudflareinsights.com` in `connect-src`.

Cloudflare guards Web Analytics sites with Account Settings: Edit to create one and Account Settings: Read to read it back, which every `apply` after the first does. So the CI token of an environment that counts visits gets both. They also reach the account's other settings. A project that adds `analytics` after `setup` runs `setup` once and answers y to "Add missing permissions to the Cloudflare CI tokens?", which adds both permissions to the same token. Until then, `apply` fails on the Web Analytics site, and `check` names the missing permission.

## Missing pages

A `cloudflare-static` frontend answers a path that matches no built file as its `not_found` field says:

| `not_found` | Answer | For |
|---|---|---|
| `spa` (default) | `200` with `index.html` | A single-page app (React, Vue, Vite) that routes in the browser. A reload of `/settings` must get the app. |
| `404-page` | `404` with the nearest `404.html` | A site with one file per page (Astro, Hugo, Docusaurus, a Next.js static export). |

On a site with one file per page, `spa` answers `200` with the home page for `/.env` or `/wp-login.php`. Scanners then continue, and crawlers follow the page's relative links below the fake path, as in `/images/images/cache.php`. A person who follows a broken link sees the home page, not the site's 404 page.

With `404-page`, Cloudflare serves the `404.html` of the nearest folder on the path, and the root `404.html` when no folder has one. Without a root `404.html`, Cloudflare answers with an empty `404`. So `deploy` and `promote` stop before `wrangler deploy` when the root of the build output has no `404.html`, and name the output folder. A `deploy --dry-run` runs the same check.

With `serve_with`, the backend's Worker serves the frontend with the frontend's `not_found`, and the backend's `paths` still reach the backend. The field applies only to `cloudflare-static`.

## What a backend must do

A `cloudflare-container` backend listens on its port, which `plan` prints with where it came from: `container.port` when the config sets it, else the TCP port of the last `EXPOSE` that has one in the Dockerfile's final stage, or in the stage it builds on, else 8080. The kit also gives the port as `PORT`. The backend reads its database, if the project has one, from `DATABASE_URL`. It needs no health route and no Dockerfile lines for the kit.

The backend receives the requests whose path starts with one of its `paths`, `/api/` by default. Set them to the prefixes the app already uses, such as `[/v1/, /auth/]`, instead of moving its routes. A backend that no frontend shares a hostname with can take `[/]`. The kit forwards each path as the browser sent it. Changing `paths` on a deployed project replaces its routes: run the Staging workflow once with `allow-deletions`, and pass `allow-deletions` to the next **Deploy to production**.

After every deploy, `smoke` reads `/_turbo-vibe/health`, which the backend's Worker answers itself. The Worker asks the container for `/`, and reports the build ID it was deployed with when the container answers below HTTP 500: a 404 proves that the server listens. To check a readiness route instead, set `container.health` to its path; then only HTTP 2xx passes. When the route's JSON carries a `build_id`, as one written for turbo-vibe 1.0 does, the Worker also compares it with its own, and answers HTTP 503 while the container still reports another build. An app error answers HTTP 502, so `smoke` gives up after about a minute. The route must answer without the database, because the pull request's dry run starts the image without one.

`deploy` follows Cloudflare's rollout until every instance runs the new image, and a promoted image reports the same ID in every environment. Cloudflare can leave a long-lived instance on the old image for a few minutes after the rollout reports completion; a health route that reports `build_id` is the way to make `smoke` wait for it. `smoke` fails unless it matches the build just deployed. It retries for about a minute. For a container backend it retries for up to five while the Worker answers HTTP 503, as it does during the first start of a new container application, or still reports the previous build, as it can for a minute or two after a deploy. A failure shows the reason the Worker gives. A frontend's build command receives `BUILD_ID` too; the kit adds `/_turbo-vibe/build-id` to its output so `smoke` can check the page as well.

The container receives the build ID as `TURBO_VIBE_BUILD_ID` at run time, and the build gets it as a build argument of the same name, for a Dockerfile that wants it. The kit also passes the build argument `BUILD_ID`, so a Dockerfile written for turbo-vibe 1.0 keeps working.

The backend must also exit on `SIGTERM`: Cloudflare waits up to 15 minutes for a container that ignores it, and every rollout waits with it. `deploy --dry-run` starts the image and fails unless the container answers the same probe on its port and `docker stop` stops it without killing it. The [adoption guide](adoption.md#1-check-the-backend) has the checks to run locally.

## Sessions on their own container

By default every request reaches one container instance, named `default`. A backend that keeps per-session state, such as WebSocket rooms, can route each request to the instance its query parameter or header names. Requests without one still go to `default`:

```yaml
    container:
      instance_from: query:session   # or header:x-session
      max_instances: 3               # required with instance_from, at least 3
```

WebSocket upgrades are forwarded with `fetch`, so a connection stays on the instance it reached.

Each build gets its own instances: the Worker names them after the session and the build, such as `room-7@4f2c9e1a0b3d`. A deploy therefore switches every new request to the new build at once, and an open connection finishes on the instance it reached. The old build's instances stop after `sleep_after` without requests. A session moves to a new instance on each deploy, so keep state that must outlive a deploy in the database.

Sessions and `default` share `max_instances`, and so do the old build's instances until they stop: once that many are running, a request for any other name fails, the smoke test's `/_turbo-vibe/health` included. Size it for the sessions you expect at once, plus one for `default`, plus room for the previous build's instances during a deploy. `examples/python-api` routes by `?session=`.

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
    callback_path: /api/auth/callback   # the default; must be under one of the backend's paths
```

`apply` first lists the environment's redirect URIs through the WorkOS API. A callback already registered by hand counts as registered and is left alone; URIs the kit did not create are never removed.

`deploy` gives every backend `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, and `WORKOS_REDIRECT_URI` (the environment's callback) as secrets. Frontend build commands run without any of the kit's credentials in their environment, so none can end up in a public bundle. The example in `examples/go-api` signs users in with AuthKit: `/api/auth/login`, `/api/auth/callback`, and `/api/me`.

## Static frontends on Vercel (beta)

A `vercel-static` frontend gets a Vercel project per environment, named `<project>-<service>-<environment>`, on that environment's hostname. A DNS-only CNAME in the Cloudflare zone points the hostname at Vercel. `deploy` runs the frontend's build in CI, then ships the files as a prebuilt output (`vercel deploy --prebuilt`), so Vercel never receives or builds the source. Promotion ships the same recorded files to the production project.

```yaml
  web:
    kind: frontend
    target: vercel-static
    build: { command: "npm ci && npm run build", output: dist }
```

With a backend in the same project, the two run on different hosts. The frontend keeps the environment's hostname, and the backend moves to its API hostname: `api.<hostname>` by default, or `environments.<env>.api_hostname`. Set it explicitly when `api.<hostname>` would be two levels below the zone, which Universal SSL does not cover. It must sit under the frontend hostname's parent domain, so the browser treats the two as one site and sends the API's sign-in cookie with the frontend's requests. Validation rejects anything else, except one case it cannot detect without a public-suffix list: a frontend directly under a public suffix such as `co.uk` (`example.co.uk` with `api.other.co.uk`). Use `api.example.co.uk` there. The kit then gives each side what the other needs, per environment:

- The backend receives `ALLOWED_ORIGINS`, set to exactly that environment's frontend URL and never a wildcard. It also receives `FRONTEND_URL`, where sign-in returns. Sign-in cookies stay on the API's own host: the kit sets no cookie domain, so a production session is never sent to a staging or preview host in the same zone. The example names its cookies `__Host-…`, which browsers accept only without a `Domain` and over HTTPS.
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

The app's server code can read its own secrets, declared like a backend's (see [Your application's own secrets](#your-applications-own-secrets)):

```yaml
  web:
    kind: frontend
    target: vercel-nextjs
    secrets: [OPENAI_API_KEY]
```

Before each deploy, preview and promotion, the kit sets each value on that environment's Vercel project as a sensitive environment variable, through Vercel's API, so the value never enters the OpenTofu state. Route handlers and server actions read it with `process.env`. A page that reads one must render per request: it calls `cookies()`, `headers()` or `connection()`, or exports `dynamic = "force-dynamic"`. Next.js renders other pages once, during `vercel build`, which receives no secrets. `examples/nextjs` shows whether `EXAMPLE_GREETING` reached its page.

## Credentials

`setup` stores these in each GitHub environment. `apply` and `deploy` read them and stop, naming any that are missing, before they run anything (`deploy` needs the `CLOUDFLARE_*` ones, plus the state ones, the `WORKOS_*` ones when it has an identity service, and the `VERCEL_*` ones when it has a Vercel frontend):

| Variable | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token, which `setup` creates per environment, with Workers Scripts: Edit and Workers Containers: Edit (account), Workers Routes: Edit, DNS: Edit and, for staging and production with a Worker, Zone Settings: Edit (zone), Access: Apps and Policies: Edit (zone) with a Worker, Account Settings: Edit and Account Settings: Read (account) for staging or production when it counts visits, Account API Tokens: Read (User API Tokens: Read on a user token) so `check` can confirm the token's own permissions, and, with a container backend, Account → Billing: Read so `check` can confirm the Workers Paid plan |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account that runs the Workers and holds the state buckets |
| `CLOUDFLARE_ZONE_ID` | the zone of the project's `domain` |
| `TURBO_VIBE_STATE_BUCKET` | an R2 bucket for OpenTofu state, which `setup` creates; staging also keeps its build records and asset archives there |
| `TURBO_VIBE_BUILDS_BUCKET` | production only: the name of staging's bucket, where `promote` reads the build records and asset archives; production's R2 token needs read access to it, and never writes there |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | an R2 API token with Object Read & Write on that bucket, which `setup` creates per environment |
| `SUPABASE_ACCESS_TOKEN` | a Supabase personal access token, for projects with a `supabase` database (`apply` and `migrate`) |
| `SUPABASE_ORGANIZATION` | the Supabase organization's slug, when the database leaves `organization` out of `turbo-vibe.yaml` (`apply`) |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` | the WorkOS environment's API key and client ID; set the staging ones on the `staging` and `preview` GitHub environments and the production ones on `production` (`apply` and `deploy`) |
| `VERCEL_API_TOKEN`, `VERCEL_TEAM_ID` | a Vercel access token and the team (or personal account) ID, for `vercel-static` frontends (`apply` and `deploy`) |

OpenTofu 1.10 or later must be on `PATH` as `tofu`. Docker must be available to `deploy`, which builds container images. `apply` and `deploy` write their working files to `.turbo-vibe/`, which `init` adds to `.gitignore`.

## Your application's own secrets

A backend, or a Next.js app's server code, lists the names of the secrets it reads, and never their values:

```yaml
  api:
    kind: backend
    target: cloudflare-container
    secrets: [STRIPE_SECRET_KEY, POSTMARK_TOKEN]
```

- **Where values live.** `setup` asks for each one in each GitHub environment, without echoing it: a test key for `staging` and `preview`, the live key for `production`. A second run keeps them; `setup --replace STRIPE_SECRET_KEY` asks again. `setup --list` names each one per environment, and `check` and `setup`'s final checks name a missing one.
- **How they arrive.** `deploy`, `promote` and `preview deploy` give each value to the service that declares it: a container backend gets it in its environment, through the same temporary `0600` file as `DATABASE_URL`; a `vercel-nextjs` app gets it as a sensitive environment variable of that environment's Vercel project, set through Vercel's API (see [Next.js on Vercel](#nextjs-on-vercel-beta)). No value enters the repository, the OpenTofu state, a build record, a command line or the output, and no build sees one. The reusable workflows hand the environment's secrets to the steps that call the CLI as one variable, `TURBO_VIBE_SECRETS`, because a reusable workflow cannot name a project's own secrets; the CLI reads only the declared names.
- **Before any change.** `apply`, `deploy`, `promote` and `preview deploy` stop, naming the secret and the GitHub environment, when a declared secret has no value. A pull request's dry run needs none, so a backend must start and answer its health probe without them.
- **Names the kit already uses.** The secrets share each GitHub environment with the kit's credentials, so validation refuses `AWS_ACCESS_KEY_ID`, `DATABASE_URL`, `PORT` and the other names the kit sets or keeps. Rename the variable in the application, such as `APP_AWS_ACCESS_KEY_ID`.

## Public values in a frontend build

Frameworks inline some values into the files they build: `NEXT_PUBLIC_*` in Next.js, `import.meta.env.VITE_*` in Vite, or anything a build script writes. Such a value is public, but it often differs per environment, such as a test publishable key on staging and the live one in production. Since production receives the build that passed staging, a frontend lists those names, and the kit puts each environment's value in:

```yaml
  web:
    kind: frontend
    target: vercel-nextjs
    public: [NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY]
```

- **Where values live.** `setup` asks for each one per environment, echoing it, and stores it as a variable of that GitHub environment. It refuses a value that holds a quote, a backslash, a `<` or a line break, because a value lands inside the framework's strings and HTML.
- **How they arrive.** The build runs with each name set to a placeholder, `__TURBO_VIBE_PUBLIC_<NAME>__`, and the build record keeps those files. Before each deploy, preview and promotion, the kit copies the files and puts that environment's value in place of each placeholder, in every text file. It stops before anything ships if a placeholder is left or a value is missing.
- **The guarantee.** Production gets the same build as staging, with production's public values. The code is the same; only the declared values differ, and the build record lists their names.
- **Identifiers, not switches.** During the build, the code sees the placeholder, not the value. A key, an ID or a DSN works; a flag that the build compares, such as `if (process.env.NEXT_PUBLIC_FLAG === "on")`, would be decided with the placeholder. Subresource-integrity hashes do not survive the replacement.

`examples/nextjs` shows `NEXT_PUBLIC_EXAMPLE_NAME` in a client component, and `examples/go-api`'s build script (`web/build.sh`) writes `EXAMPLE_PUBLIC_NAME` into its page.

## Secrets only the build needs

Some builds need a secret that the running app never reads: an `NPM_TOKEN` that installs a package from a private registry, a `SENTRY_AUTH_TOKEN` that uploads source maps. A service lists them under `build`:

```yaml
  api:
    kind: backend
    target: cloudflare-container
    build:
      dockerfile: Dockerfile
      secrets: [NPM_TOKEN]
```

- **One value for every environment.** The kit builds once, on staging or in a preview, and promotes that build, so a build secret has a single value. `setup` asks for it once, without echoing it, and stores it as a repository secret. A same-repository pull request's dry run builds with it; a fork's receives none, and its dry run skips that service's build and says so.
- **A frontend's build** gets its own build secrets in its environment, and nothing else of the kit's. After the build, the kit searches every built file for each value and stops before anything ships if it finds one, naming the secret and the file, never the value.
- **A backend's `docker build`** gets each one as a BuildKit secret, `--secret id=<NAME>,env=<NAME>`. Read it in the step that needs it, and no image layer keeps it:

  ```dockerfile
  RUN --mount=type=secret,id=NPM_TOKEN NPM_TOKEN="$(cat /run/secrets/NPM_TOKEN)" npm ci
  ```

  The kit cannot search an image the way it searches files, so never copy the value into the image: no `ARG` or `ENV` for it, and no `COPY` of a file that holds it.
- **Promotion** needs none, since it builds nothing. `deploy` and `preview deploy` stop before anything changes when a build secret has no value.

## Actions minutes per run

Public repositories run GitHub's standard runners at no cost. In a private repository, each run spends minutes from the account's allowance (2,000 a month on GitHub Free). The test-and-build job below was measured on the kit's example. The deploy figures are estimates from their steps.

| Run | Jobs | Minutes |
|---|---|---|
| Pull request | test and build (`test`, `deploy --dry-run`) | about 2 (measured 1.5–2) |
| Merge to `main` | test and build, then deploy staging (`apply`, `migrate`, Docker build and push, `deploy`, `smoke`) | about 7–10, estimated |
| Deploy to production | one job: `apply`, `migrate`, `promote`, `smoke`, with no build | about 3–5, estimated |

The image build dominates staging. Promotion skips it, which is why it costs less.

## Coding assistants

`init --assistant claude`, `cursor`, or a list such as `claude,cursor`, writes guidance for coding assistants (`.claude/skills/turbo-vibe/SKILL.md`, `.cursor/rules/turbo-vibe.mdc`), stamped with the CLI's version. It teaches them to change infrastructure only through `turbo-vibe.yaml`, to show `plan --env` before proposing a change, to walk a person through `setup --list` and send them to a terminal for `setup` without ever handling a secret, and to leave production promotion to a person. In a project that already has `turbo-vibe.yaml`, `init --only-assistant --assistant claude` writes just the guidance. For a project that does not use turbo-vibe yet, `adopt --assistant claude` writes `.claude/skills/turbo-vibe-adopt/SKILL.md` (and `.cursor/rules/turbo-vibe-adopt.mdc` for Cursor), which takes the assistant from the existing code to a pull request; see [`adopt`](#commands-in-detail). In a git repository, `adopt` lists those files in `.git/info/exclude`, so they are never committed. Without the flag, `init` and `adopt` write for the assistants the repository already uses (a `.claude/` folder or `CLAUDE.md`, a `.cursor/` folder or `.cursorrules`), ask in a terminal when there are none, and otherwise write no guidance; `--no-assistant` writes none.

## Moving between hosts

Nothing that turbo-vibe owns. Every resource lives in your own vendor accounts, and the OpenTofu state and build records live in your own bucket. To stop using the kit, delete `turbo-vibe.yaml` and its workflows; your services keep running where they are.

Moving between vendors is a different question. The kit sets up each host the same way, but a move is still work:

| Part of the app | What moving it takes |
|---|---|
| A static frontend | Possible between `cloudflare-static` and `vercel-static` (beta), with work. On Vercel the page and the API have different origins, so: change `target` and remove `serve_with`; set `api_hostname` where `api.<hostname>` would be two levels below the zone; make the backend accept only `ALLOWED_ORIGINS`; and have the page read its API URL from `/_turbo-vibe/config.json`. See [Static frontends on Vercel](#static-frontends-on-vercel-beta). Moving back means adding `serve_with` again. |
| A Next.js frontend | Not through the kit: `vercel-nextjs` (beta) is its only target. |
| A backend container | Not through the kit yet: `cloudflare-container` is its only target. The image is built from your own Dockerfile and runs on any container host, given, at runtime, `PORT`, `TURBO_VIBE_BUILD_ID`, `DATABASE_URL` and the sign-in and origin settings. If it sets `container.instance_from`, the new host must route those requests to the same instance itself. |
| Database data | No. Moving a Supabase database's data to another provider is your own migration. |
| Signed-in users | No. Users and their sessions stay in WorkOS. |
