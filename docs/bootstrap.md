# Bootstrap checklist

`turbo-vibe setup` does most of the one-time setup. It creates the GitHub environments, the Cloudflare zone, the state bucket and the Cloudflare tokens, and it stores every secret in its GitHub environment. This page lists what it leaves to you: accounts, plans, and the tokens that no API can create. Do only the sections for the targets your `turbo-vibe.yaml` uses, then [run `setup`](#6-run-setup). `setup --list` prints the list for your file, with a link for each step, and changes nothing. Every paid plan is named at the step that needs it, before anything is created.

## 1. GitHub

1. Put the project in a GitHub repository.
   - **Actions minutes:** public repositories run Actions at no cost. Private ones spend minutes from the account's allowance; see the README's [Actions minutes per run](../README.md#actions-minutes-per-run).
2. Install the [GitHub CLI](https://cli.github.com) and run `gh auth login`. `setup` uses it to create the environments and store the secrets.

`setup` creates the `staging` and `production` environments. It adds you as a **required reviewer** on `production`, which is the approval that "Deploy to production" waits for. GitHub offers reviewers on public repositories and on paid plans. On a private repository on GitHub Free, `setup` warns and continues: every promotion still has to be confirmed by typing the build ID. `setup` creates `staging` without branch restrictions. If `staging` already exists and the project uses previews, leave its deployment branches unrestricted: previews run in `staging` from pull request branches.

## 2. Domain and Cloudflare (every project)

DNS for the project's hostnames lives in Cloudflare, even when the frontend runs on Vercel.

1. Create a Cloudflare account, and have the project's domain registered (at Cloudflare or anywhere else).
2. Choose hostnames **one level below the zone**: `staging-app.example.com`, not `staging.app.example.com`. Cloudflare's free Universal SSL certificate covers only the apex and first-level names. A deeper hostname needs Advanced Certificate Manager, a paid add-on.
3. If the project has a `cloudflare-container` backend, it needs **Workers Paid**. Containers are not available without it. The plan includes an amount of container memory, CPU and disk each month, and bills usage beyond it; see Cloudflare's Containers pricing page. Small instances that sleep when idle keep a staging API within the included amounts. `setup` checks the plan first and waits while you subscribe.
4. R2 must be enabled once on the account (R2 Object Storage in the dashboard). R2's free tier covers the kit's state files and archives for most projects. If it is not enabled, `setup` gives you the link and waits.
5. Create a **bootstrap token**, owned by the account: Manage Account → Account API Tokens → Create Token → Custom token, with the single permission **Account → Account API Tokens: Edit**. Give it a short expiry, such as one day. `setup` asks for it, uses it, and offers to delete it at the end. A later run that has to create a Cloudflare token asks for a bootstrap token again: a new environment, `--replace` of a Cloudflare secret, or a Cloudflare secret deleted from GitHub. Create a new one the same way.
6. Keep the **account ID** at hand: `setup` asks for it first. It is the part after `dash.cloudflare.com/` in the dashboard's address, and the account's overview page shows it too.

From the bootstrap token, `setup`:

- finds the zone for your domain, or creates it. While the zone is pending, it prints the two nameservers to set at your registrar. Registration can stay where it is. `check` reports the zone as pending until the change is done, which can take hours.
- finds or creates the state bucket `<project>-turbo-vibe-state`.
- creates, for each environment, a CI token `turbo-vibe-<project>-<env>` with exactly the permissions `check` requires, and an R2 token `turbo-vibe-<project>-<env>-r2` that can read and write only the state bucket.

It does the zone and bucket work through a token named `turbo-vibe-<project>-setup`, which expires after an hour and which it deletes when it is done.

## 3. Supabase (projects with a `supabase` database)

1. Create a Supabase organization. An access token cannot create one.
2. Choose the plan.
   - **Free:** two active projects per organization, which is exactly staging and production for one app. A free project **pauses after a week without activity**, and `check` and `migrate` report it. Restore it from the dashboard.
   - **Pro** (or higher): needed for `staging: branch`, a persistent staging branch of the production project, and for preview environments; branch compute is billed per hour.
3. Create a personal access token (Account → Access Tokens). `setup` asks for it once, for every environment. When `turbo-vibe.yaml` leaves `organization` out, which keeps the slug out of a public repository, `setup` finds the organizations the token sees, asks you to choose when there is more than one, and stores the organization's slug as `SUPABASE_ORGANIZATION`.

## 4. WorkOS (projects with a `workos` identity service)

1. Create a WorkOS workspace. It has a staging and a production environment.
2. To use the production environment, a team admin adds **billing** in the WorkOS dashboard. Production unlocks after that.
3. Keep each environment's API Keys page open. `setup` asks for the API key and the client ID of each GitHub environment. The production key is shown **only once**. For the client ID, click the application named in the key's row; the application's page shows it. `setup` refuses a production key (`sk_live_`) for `staging` and a staging key (`sk_test_`) for `production`.

## 5. Vercel (projects with a `vercel-static` or `vercel-nextjs` frontend)

1. Create a Vercel account or team.
   - **Hobby** forbids commercial use, and `check` warns about it. A commercial project needs **Pro**.
2. Create an access token (Account Settings → Tokens), scoped to the team. `setup` asks for it once, finds the team from it, and asks you to choose only when the token sees more than one.

## 6. Run setup

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

## The kit's own repository

Only turbo-vibe's repository needs this. Its weekly live tests (`live-tests.yml`) deploy the examples as previews, smoke-test them, remove them, and record the results in `COMPATIBILITY.md`.

1. Run `setup --env live`. The `live` environment gets the same kind of values as `staging`, and no reviewers: it only creates and removes preview environments.
2. Let the workflow push to `main`: it commits `COMPATIBILITY.md` when a run changes it. If `main` is protected, allow GitHub Actions to bypass the rule, or the commit is rejected and the run fails.
