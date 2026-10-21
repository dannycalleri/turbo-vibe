# Bootstrap checklist

`turbo-vibe setup` does most of the one-time setup. It creates the GitHub environments, the Cloudflare zone, a state bucket per environment and the Cloudflare tokens, and it stores every secret in its GitHub environment. This page lists what it leaves to you: accounts, plans, and the tokens that no API can create. Do only the sections for the targets your `turbo-vibe.yaml` uses, then [run `setup`](#7-run-setup). `setup --list` prints the list for your file, with a link for each step, and changes nothing. Every paid plan is named at the step that needs it, before anything is created.

## 1. GitHub

1. Put the project in a GitHub repository.
   - **Actions minutes:** public repositories run Actions at no cost. Private ones spend minutes from the account's allowance; see the reference's [Actions minutes per run](reference.md#actions-minutes-per-run).
2. Install the [GitHub CLI](https://cli.github.com) and run `gh auth login`. `setup` uses it to create the environments and store the secrets.

`setup` creates the `staging` and `production` environments, and a `preview` environment when the config enables previews. It limits `staging` and `production` to deployments from `main`, so a pull request branch never receives their secrets; previews run in `preview`, which has its own bucket and tokens. It adds you as a **required reviewer** on `production`, which is the approval that "Deploy to production" waits for. Public repositories get both. A private repository needs GitHub Pro, Team or Enterprise for deployment-branch rules, and GitHub Enterprise for required reviewers. Where GitHub refuses one, `setup` warns and continues. Without a reviewer, every promotion still has to be confirmed by typing the build ID. Without a deployment-branch rule, a workflow on any branch could ask for `staging`'s or `production`'s secrets.

## 2. Domain and Cloudflare (every project)

DNS for the project's hostnames lives in Cloudflare, even when the frontend runs on Vercel.

1. Create a Cloudflare account, and have the project's domain registered (at Cloudflare or anywhere else).
2. Choose hostnames **one level below the zone**: `staging-app.example.com`, not `staging.app.example.com`. Cloudflare's free Universal SSL certificate covers only the apex and first-level names. A deeper hostname needs Advanced Certificate Manager, a paid add-on.
3. If the project has a `cloudflare-container` backend, it needs **Workers Paid**. Containers are not available without it. The plan includes an amount of container memory, CPU and disk each month, and bills usage beyond it; see Cloudflare's Containers pricing page. Small instances that sleep when idle keep a staging API within the included amounts. `setup` checks the plan first and waits while you subscribe.
4. R2 must be enabled once on the account (R2 Object Storage in the dashboard). R2's free tier covers the kit's state files and archives for most projects. If it is not enabled, `setup` gives you the link and waits.
5. Create a **bootstrap token**, owned by the account. `setup` shows these steps and offers to open the page:
   1. Open the page below: it fills in the name "turbo-vibe bootstrap" and the permission Account API Tokens: Edit
   2. If the permission is missing, choose Account, Account API Tokens, Edit under Permissions
   3. Under TTL, set the end date to tomorrow
   4. Click "Continue to summary", then "Create Token", and copy the token

   Page: [create the bootstrap token](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22account_api_tokens%22%2C%22type%22%3A%22edit%22%7D%5D&name=turbo-vibe%20bootstrap). Permissions: Account API Tokens: Edit, and nothing else; setup creates every other token from it.

   `setup` asks for the token, uses it, and offers to delete it at the end. A later run that has to create a Cloudflare token asks for a bootstrap token again: a new environment, `--replace` of a Cloudflare secret, or a Cloudflare secret deleted from GitHub. Create a new one the same way.
6. `setup` reads the account from the bootstrap token. It asks which one only when the token sees more than one account.

From the bootstrap token, `setup`:

- finds the zone for your domain, or creates it. While the zone is pending, it prints the two nameservers to set at your registrar. Registration can stay where it is. `check` reports the zone as pending until the change is done, which can take hours.
- finds or creates a state bucket for each environment, `<project>-turbo-vibe-<env>`, such as `acme-turbo-vibe-staging` and `acme-turbo-vibe-production`.
- creates, for each environment, a CI token `turbo-vibe-<project>-<env>` with exactly the permissions `check` requires, and an R2 token `turbo-vibe-<project>-<env>-r2` that can read and write only that environment's bucket. Production's R2 token can also read staging's bucket, where it finds the builds to promote, and cannot write there.

It does the zone and bucket work through a token named `turbo-vibe-<project>-setup`, which expires after an hour and which it deletes when it is done.

## 3. Supabase (projects with a `supabase` database)

1. Create a Supabase organization. An access token cannot create one.
2. Choose the plan.
   - **Free:** two active projects per organization, which is exactly staging and production for one app. A free project **pauses after a week without activity**, and `check` and `migrate` report it. Restore it from the dashboard.
   - **Pro** (or higher): needed for `staging: branch`, a persistent staging branch of the production project, and for preview environments; branch compute is billed per hour.
3. Create a personal access token on [the access tokens page](https://supabase.com/dashboard/account/tokens):
   1. Click "Generate new token"
   2. Name it "turbo-vibe" and choose an expiry
   3. Click "Generate token", and copy the token

   Permissions: a personal access token reaches every organization you belong to; setup lists them and you choose one.

   `setup` asks for it once, for every environment, and checks it at once. When `turbo-vibe.yaml` leaves `organization` out, which keeps the slug out of a public repository, `setup` finds the organizations the token sees, asks you to choose when there is more than one, and stores the organization's slug as `SUPABASE_ORGANIZATION`.

## 4. WorkOS (projects with a `workos` identity service)

1. Create a WorkOS workspace. It has a staging and a production environment.
2. To use the production environment, a team admin adds **billing** in the WorkOS dashboard. Production unlocks after that.
3. Keep [the API Keys page](https://dashboard.workos.com/api-keys) open. `setup` asks for the API key and the client ID of each GitHub environment:
   1. Choose the environment at the top left: Staging for staging and previews, Production for production
   2. On API Keys, copy the secret key; a production key is shown only when it is created
   3. Open the application linked from the key's row, and copy its Client ID

   Permissions: the environment's own secret key: staging's starts with sk_test_, production's with sk_live_.

   `setup` refuses a production key (`sk_live_`) for `staging` and a staging key (`sk_test_`) for `production`, and checks each key with WorkOS when you enter it.

## 5. Vercel (projects with a `vercel-static` or `vercel-nextjs` frontend)

1. Create a Vercel account or team.
   - **Hobby** forbids commercial use, and `check` warns about it. A commercial project needs **Pro**.
2. Create an access token on [the tokens page](https://vercel.com/account/settings/tokens):
   1. Under "Create Token", name it "turbo-vibe"
   2. Under Scope, choose the team that will own the projects
   3. Choose an expiration, click "Create", and copy the token

   Permissions: scoped to the one team that owns the projects.

   `setup` asks for it once, finds the team from it, and asks you to choose only when the token sees more than one.

## 6. The application's own values (projects that declare `secrets`, `public` or `build.secrets`)

Keep each value at hand before you run `setup`. Each kind is asked for and stored differently:

- **Runtime secrets (`secrets`):** one value per environment, such as a test key for `staging` and `preview` and a live key for `production`. `setup` asks for each one per environment without echoing it, names the service that declares it, and stores it in that GitHub environment. The value reaches only the running service.
- **Public values (`public`):** one value per environment. `setup` echoes each one as you type it and stores it as a variable of that GitHub environment, because it ends up in the built files.
- **Build secrets (`build.secrets`):** one value for the whole repository. `setup` asks for each one once, without echoing it, and stores it as a repository secret. Only the build receives it.

## 7. Run setup

In a terminal, in the repository:

```sh
npx @turbo-vibe/cli@1 setup
```

`setup` reads each token without echoing it and hands each value to `gh secret set` on standard input, so no value reaches the disk, a command line or the output. It ends with the same checks as `check`, run on the values it stored. Fix each `FAIL` line using its `fix:` line. When the fix is a new value for a secret that `setup` stored, run `setup --replace <SECRET>`: a plain second run keeps every secret that already exists, so it would keep the wrong one.

- **A second run** keeps every secret that an environment already has, and asks only for what is missing. When a Cloudflare token's secret is gone from GitHub, it deletes the token and creates a new one, because Cloudflare shows a token's value only once.
- **`--replace <SECRET>`** asks for that secret again in every environment, and creates its Cloudflare token again. Use it when you rotate a token.
- **`--env <name>`** sets up only the named environments. Any name other than `production` is set up like `staging`.

`setup` needs a person at the terminal. A coding assistant can tell you what to do, but it must not run `setup` or ask you for a token's value.

`setup` stores values that you never see, such as the Cloudflare tokens, so you cannot export them to run `check` in your shell. To verify an environment again, run `setup` again: it checks the values it stores in that run, and lists the ones it kept. To check a kept secret, set it again with `--replace <SECRET>`. `check` changes nothing except one probe object it writes to the state bucket and deletes, to prove R2 enforces state locking. To run it on a GitHub environment's stored secrets, add it as a step to a workflow job that uses that environment.

## 8. What one account leaves shared

Each environment has its own GitHub environment, state bucket and tokens, and `staging` and `production` accept runs from `main` only. Some things are still shared, because Cloudflare cannot narrow them within one account and zone:

| What | Who can reach production through it |
|---|---|
| Workers | every environment's Cloudflare token can deploy any Worker in the account, production's included |
| Container applications | with a `cloudflare-container` backend, every environment's token can change any container application, production's image included |
| DNS records and routes | every environment's token can edit the zone's DNS records, and its routes when a Cloudflare target runs Workers, so it could point production's hostnames elsewhere |
| Supabase | the access token reaches every project in its organization |
| Vercel | the token reaches every project in its team |
| WorkOS | staging and previews share the WorkOS staging environment's key |
| Previews | pull request code runs with the preview's tokens, which reach as far as every row above |
| GitHub | on a private repository without GitHub Pro, Team or Enterprise, there are no deployment-branch rules, so a workflow on any branch could ask for `staging`'s or `production`'s secrets |

For a project with real users:
- Give production its own Supabase organization and Vercel team, with their own tokens.
- Keeping staging and previews away from production's Workers, containers and DNS needs production in its own Cloudflare account and zone, as Cloudflare recommends. turbo-vibe does not support that yet.

`setup --list` prints the rows that apply to your file. It cannot see your GitHub plan, so it always prints the GitHub row.

## The kit's own repository

Only turbo-vibe's repository needs this. Its weekly live tests (`live-tests.yml`) deploy the examples as previews, smoke-test them, remove them, and record the results in `COMPATIBILITY.md`.

1. Run `setup --env live`. The `live` environment gets the same kind of values as `staging`, and no reviewers: it only creates and removes preview environments.
2. When a run changes `COMPATIBILITY.md`, the workflow opens a pull request from `live-results/<run number>` and sets it to merge itself once `main`'s required checks pass. It closes the previous week's pull request if that one is still open. Create a fine-grained personal access token for this repository only, with Contents and Pull requests set to Read and write, and store it as `LIVE_RESULTS_TOKEN` in the `live` environment: GitHub runs no checks on a pull request opened with the workflow's own token, so it would never merge. Turn on "Allow auto-merge" in the repository's settings. `main` can then require pull requests and status checks with no exception for the workflow. Renew the token before it expires.
3. Create a GitHub environment named `release`, with you as a required reviewer where GitHub offers it, and limit npm's trusted publisher for `@turbo-vibe/cli` to the workflow `release.yml` and the environment `release`. The release workflow publishes only through that environment, and only a release whose commit is on `main`. A version with a prerelease part, such as `1.0.0-rc.1`, is published under the npm dist-tag `next`, and never moves the `v1` tag.
4. Create a fine-grained personal access token for this repository only, with Contents, Pull requests, Issues and Workflows set to Read and write, and store it as the repository secret `RELEASE_PLEASE_TOKEN`. [release-please](https://github.com/googleapis/release-please) uses it to keep a release pull request open from the Conventional Commits merged to `main`. That pull request bumps the CLI pin in the three reusable workflows, which GitHub refuses from the workflow's own token, and because it comes from your token, the pull request runs the usual checks. Merging it tags the release, and the same run publishes it. If publishing fails or the `release` environment's reviewer rejects it, the tag already exists and the next push to `main` does not try again: use "Re-run failed jobs" on that run. If the tagged commit itself is broken, fix it with a new commit, which becomes the next release. Renew the token before it expires.
