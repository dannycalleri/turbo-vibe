# Next.js on Vercel (beta)

A Next.js app with one server-rendered page, built in CI with `vercel build` and shipped prebuilt to Vercel. Its DNS stays on Cloudflare.

## Walkthrough: from `init` to production

You need the GitHub repository, accounts, tokens and GitHub environments from the [bootstrap checklist](../../docs/bootstrap.md), sections 1, 2 and 5, and Node 24 and [OpenTofu](https://opentofu.org/docs/intro/install/) on your machine (`plan --env` runs it). Below, `you/my-site` stands for that repository and `app.example.com` for your domain.

1. Clone your repository and copy the example into it, without its config:

   ```sh
   git clone git@github.com:you/my-site.git && cd my-site
   cp -R <turbo-vibe checkout>/examples/nextjs/. .
   rm -rf turbo-vibe.yaml node_modules
   echo .turbo-vibe/ >> .gitignore
   ```

2. Write the config and the two workflows:

   ```sh
   npx @turbo-vibe/cli@1 init --name my-site --domain app.example.com --backend none --frontend vercel-nextjs --database none --identity none --assistant claude
   ```

   The config `init` writes needs no changes: `build.command` installs the dependencies, and `vercel build` runs `next build` itself.

3. Check the file. It needs no credentials:

   ```sh
   npx @turbo-vibe/cli@1 plan
   ```

4. Export the staging environment's secrets in your shell, plus `GITHUB_TOKEN` (a token that can read the repository's environments) and `GITHUB_REPOSITORY=you/my-site`. Then check the accounts and see what the first apply will create:

   ```sh
   npx @turbo-vibe/cli@1 check --env staging
   npx @turbo-vibe/cli@1 plan --env staging
   ```

   On Vercel's Hobby plan, `check` warns that it forbids commercial use.

5. Commit and push to `main`. The **Staging** workflow builds the app once, deploys it to a Vercel project of its own, and smoke-tests it.
   Check: `https://staging-app.example.com/_turbo-vibe/build-id` returns the pushed commit's SHA. The run's summary names the build to promote.

6. Run **Deploy to production** from the Actions tab, with that build ID as **confirm-build**.
   Check: `https://app.example.com/_turbo-vibe/build-id` returns the same SHA. Production received the build output staging tested; nothing was rebuilt.
