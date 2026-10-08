# Bootstrap checklist

The one-time steps a machine cannot do for you. Do only the sections for the targets your `turbo-vibe.yaml` uses. Every cost is stated at the step that incurs it, before anything is created. When you are done, run `npx @turbo-vibe/cli@1 check --env staging`, then again with `--env production`. It names anything still missing.

## 1. GitHub

1. Put the project in a GitHub repository.
   - **Cost:** public repositories run Actions at no cost. Private ones spend minutes from the account's allowance; see the README's [Actions minutes per run](../README.md#actions-minutes-per-run).
2. In Settings → Environments, create `staging` and `production`.
3. On `production`, add **required reviewers**. This is the approval that "Deploy to production" waits for.
4. Each later step names secrets. Add them to the GitHub environment they belong to (Settings → Environments → *name* → Environment secrets). The names are the same in both environments; the values are each environment's own.

## 2. Domain and Cloudflare (every project)

DNS for the project's hostnames lives in Cloudflare, even when the frontend runs on Vercel.

1. Create a Cloudflare account.
2. Add your domain as a zone (Websites → Add a site). If the domain is registered elsewhere, set the nameservers Cloudflare shows at your registrar. Registration can stay where it is. `check` reports a zone that is still pending.
3. Choose hostnames **one level below the zone**: `staging-app.example.com`, not `staging.app.example.com`. Cloudflare's free Universal SSL certificate covers only the apex and first-level names. A deeper hostname needs Advanced Certificate Manager, a paid add-on.
4. If the project has a `cloudflare-container` backend, subscribe to **Workers Paid**.
   - **Cost:** $5 per month. It includes 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk a month; beyond that, usage is billed per second.
   - Containers are not available without it.
   - Small instances that sleep when idle keep a staging API within the included amounts.
5. Create an **API token** (My Profile → API Tokens → Create Custom Token) with:
   - Account → Workers Scripts: Edit, and Account → Containers: Edit (with a container backend);
   - Zone → Workers Routes: Edit, and Zone → DNS: Edit, for your zone;
   - User → API Tokens: Read, so `check` can confirm the permissions above without changing anything;
   - Account → Billing: Read (with a container backend), so `check` can confirm Workers Paid.
6. Create an **R2 bucket** for OpenTofu state and build records (R2 → Create bucket).
   - **Cost:** R2's free tier covers the kit's state files and archives for most projects.
   - Then create an R2 API token with Object Read & Write on that bucket.
7. Add the secrets to both environments:
   - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`;
   - `TURBO_VIBE_STATE_BUCKET` (the bucket's name);
   - `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (the R2 token's key pair).

## 3. Supabase (projects with a `supabase` database)

1. Create a Supabase organization. Put its slug in `turbo-vibe.yaml` as `organization`.
2. Choose the plan.
   - **Free:** two active projects per organization, which is exactly staging and production for one app. A free project **pauses after a week without activity**, and `check` and `migrate` report it. Restore it from the dashboard.
   - **Pro:** about $25 per month per organization. Needed for `staging: branch`, a persistent staging branch of the production project, and for preview environments; branch compute is billed per hour.
3. Create a personal access token (Account → Access Tokens), and add it as `SUPABASE_ACCESS_TOKEN` to both environments.

## 4. WorkOS (projects with a `workos` identity service)

1. Create a WorkOS workspace. It has a staging and a production environment.
2. To use the production environment, a team admin adds **billing** in the WorkOS dashboard. Production unlocks after that.
3. From each environment's API Keys page, copy the API key and the client ID. The production key is shown **only once**.
4. Add `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` with the **staging** environment's values to `staging`, and the **production** values to `production`. `check` refuses a production key on staging.

## 5. Vercel (projects with a `vercel-static` or `vercel-nextjs` frontend)

1. Create a Vercel account or team.
   - **Cost:** Hobby is free but forbids commercial use; `check` warns about it. Pro is $20 per user per month.
2. Create an access token (Account Settings → Tokens), scoped to the team. Copy the team ID (Team Settings → General).
3. Add `VERCEL_API_TOKEN` and `VERCEL_TEAM_ID` to both environments.

## 6. Check

```sh
npx @turbo-vibe/cli@1 check --env staging
npx @turbo-vibe/cli@1 check --env production
```

Run each with that environment's values in your shell, or as a workflow step in that GitHub environment. To check the GitHub side too, also set `GITHUB_TOKEN` (a token that can read the repository's environments) and `GITHUB_REPOSITORY` (`owner/name`). Fix each `FAIL` line using its `fix:` line, until both environments report `ready`. `check` changes nothing except one probe object it writes to the state bucket and deletes, to prove R2 enforces state locking.
