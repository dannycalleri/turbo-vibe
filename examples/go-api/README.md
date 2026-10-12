# Go API with a page, a database and sign-in

A Go API and a static page served from one Cloudflare Worker, a Supabase database with one migration, and sign-in with WorkOS AuthKit. `GET /api/health` reports the running build's ID and the row the migration inserts. `/api/auth/login` signs a user in, and `/api/me` shows who they are.

## Walkthrough: from `init` to production

You need the GitHub repository, accounts and tokens from the [bootstrap checklist](../../docs/bootstrap.md), sections 1 to 4, and Node 24, a signed-in [GitHub CLI](https://cli.github.com) and [OpenTofu](https://opentofu.org/docs/intro/install/) on your machine (`setup` runs the checks, which need OpenTofu). Below, `you/my-app` stands for that repository and `app.example.com` for your domain.

1. Clone your repository and copy the example into it, without its config:

   ```sh
   git clone git@github.com:you/my-app.git && cd my-app
   cp -R <turbo-vibe checkout>/examples/go-api/. .
   rm turbo-vibe.yaml
   echo .turbo-vibe/ >> .gitignore
   ```

2. Write the config and the two workflows:

   ```sh
   npx @turbo-vibe/cli@1 init --name my-app --domain app.example.com --backend cloudflare-container --frontend cloudflare-static --database supabase --identity workos --assistant claude
   ```

   Then replace the defaults `init` marks in `turbo-vibe.yaml` with this example's values:

   ```yaml
   services:
     api:
       build:
         dockerfile: Dockerfile
         test: docker run --rm -v "$PWD":/src -w /src golang:1.27 go test ./...
     web:
       build:
         command: web/build.sh
         output: web/dist
     db:
       organization: your-supabase-org-slug   # Organization Settings → Organization slug
       region: eu-central-1
   ```

3. Check the file. It needs no credentials:

   ```sh
   npx @turbo-vibe/cli@1 plan
   ```

   You should see `api` at `https://staging-app.example.com/api/` and `web` at `https://staging-app.example.com/`, and the same for production at `app.example.com`.

4. Set up the GitHub environments and their secrets. In a terminal, in the repository:

   ```sh
   npx @turbo-vibe/cli@1 setup
   ```

   It asks for each token the checklist had you create, without echoing it, and stores every value in the `staging` and `production` GitHub environments. It ends with a check of each environment. A `FAIL` on a value you entered is fixed with `setup --replace <SECRET>`, which asks for it again and checks it; a plain second run asks only for what is still missing. On a free GitHub plan with a private repository, it warns that `production` has no required reviewer; that is expected.

5. Commit and push to `main`. The **Staging** workflow tests, applies the infrastructure, migrates the database, builds and deploys, and smoke-tests.
   Check: `https://staging-app.example.com/api/health` returns the pushed commit's SHA as `build_id` and the migration's row as `database`. The run's summary names the build to promote.

6. Run **Deploy to production** from the Actions tab, with that build ID as **confirm-build**, and approve it if `production` has reviewers.
   Check: `https://app.example.com/api/health` reports the same `build_id`. The run's log has no `docker build`: production got the build staging tested.

From then on, every merge to `main` deploys staging. Before a change that touches the services, `npx @turbo-vibe/cli@1 plan --env staging` shows what it will create, change or delete.
