# Python API

A standard-library Python API in a container on Cloudflare. Requests with `?session=<name>` reach a container instance of their own (up to three), so per-session state stays in one place; requests without it share the `default` instance.

## Walkthrough: from `init` to production

You need the GitHub repository, accounts and tokens from the [bootstrap checklist](../../docs/bootstrap.md), sections 1 and 2, and Node 24, a signed-in [GitHub CLI](https://cli.github.com) and [OpenTofu](https://opentofu.org/docs/intro/install/) on your machine (`setup` runs the checks, which need OpenTofu). Below, `you/my-api` stands for that repository and `app.example.com` for your domain.

1. Clone your repository and copy the example into it, without its config:

   ```sh
   git clone git@github.com:you/my-api.git && cd my-api
   cp -R <turbo-vibe checkout>/examples/python-api/. .
   rm turbo-vibe.yaml
   ```

2. Write the config and the two workflows:

   ```sh
   npx @turbo-vibe/cli@1 init --name my-api --domain app.example.com --backend cloudflare-container --frontend none --database none --identity none --assistant claude
   ```

   Then set the backend's test command and its instance routing in `turbo-vibe.yaml`:

   ```yaml
   services:
     api:
       build:
         dockerfile: Dockerfile
         test: docker run --rm -v "$PWD":/src -w /src python:3.13-slim python -m unittest -v
       container:
         instance_from: query:session
         max_instances: 3
   ```

3. Check the file. It needs no credentials:

   ```sh
   npx @turbo-vibe/cli@1 plan
   ```

4. Set up the GitHub environments and their secrets. In a terminal, in the repository:

   ```sh
   npx @turbo-vibe/cli@1 setup
   ```

   It asks for each token the checklist had you create, without echoing it, and stores every value in the `staging` and `production` GitHub environments. It ends with a check of each environment. A `FAIL` on a value you entered is fixed with `setup --replace <SECRET>`, which asks for it again and checks it; a plain second run asks only for what is still missing.

5. Commit and push to `main`. The **Staging** workflow tests, applies, builds and deploys, and smoke-tests.
   Check: `https://staging-app.example.com/api/health` returns the pushed commit's SHA as `build_id`, with or without `?session=a`. The run's summary names the build to promote.

6. Run **Deploy to production** from the Actions tab, with that build ID as **confirm-build**.
   Check: `https://app.example.com/api/health` reports the same `build_id`.

For a preview of every pull request, add `previews: true` to `turbo-vibe.yaml` and the `previews.yml` caller from the [adoption guide](../../docs/adoption.md).
