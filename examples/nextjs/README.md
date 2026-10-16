# Next.js on Vercel (beta)

A Next.js app with one server-rendered page, built in CI with `vercel build` and shipped prebuilt to Vercel. Its DNS stays on Cloudflare.

## Walkthrough: from `init` to production

You need the GitHub repository, accounts and tokens from the [bootstrap checklist](../../docs/bootstrap.md), sections 1, 2 and 5, and Node 24, a signed-in [GitHub CLI](https://cli.github.com) and [OpenTofu](https://opentofu.org/docs/intro/install/) on your machine (`setup` runs the checks, which need OpenTofu). Below, `you/my-site` stands for that repository and `app.example.com` for your domain.

1. Clone your repository and copy the example into it, without its config:

   ```sh
   git clone git@github.com:you/my-site.git && cd my-site
   cp -R <turbo-vibe checkout>/examples/nextjs/. .
   rm -rf turbo-vibe.yaml node_modules
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

4. Set up the GitHub environments and their secrets. In a terminal, in the repository:

   ```sh
   npx @turbo-vibe/cli@1 setup
   ```

   It asks for each token the checklist had you create, without echoing it, and stores every value in the `staging` and `production` GitHub environments. It ends with a check of each environment. A `FAIL` on a value you entered is fixed with `setup --replace <SECRET>`, which asks for it again and checks it; a plain second run asks only for what is still missing. On Vercel's Hobby plan, the checks warn that it forbids commercial use.

5. Commit and push to `main`. The **Staging** workflow builds the app once, deploys it to a Vercel project of its own, and smoke-tests it.
   Check: `https://staging-app.example.com/_turbo-vibe/build-id` returns the pushed commit's SHA. The run's summary names the build to promote.

6. Run **Deploy to production** from the Actions tab, with that build ID as **confirm-build**.
   Check: `https://app.example.com/_turbo-vibe/build-id` returns the same SHA. Production received the build output staging tested; nothing was rebuilt.
