# turbo-vibe

Deploy a project's services from one `turbo-vibe.yaml`.

```sh
npx @turbo-vibe/cli plan
npx @turbo-vibe/cli test
npx @turbo-vibe/cli apply --env staging
npx @turbo-vibe/cli deploy --env staging --build-id "$(git rev-parse --short HEAD)"
npx @turbo-vibe/cli smoke --env staging --build-id "$(git rev-parse --short HEAD)"
```

`deploy --dry-run` builds everything and validates the Worker without credentials.

## What a backend must do

A `cloudflare-container` backend listens on port 8080 (also given as `PORT`) and answers `GET /api/health` with JSON containing `build_id`. The kit passes the build ID to `docker build` as the build argument `BUILD_ID`; the Dockerfile's final stage turns it into the environment variable the app reports:

```dockerfile
ARG BUILD_ID
ENV BUILD_ID=$BUILD_ID
```

The ID lives in the image, so `smoke` proves which image is serving, and a promoted image reports the same ID in every environment. `smoke` fails unless it matches the build just deployed. A frontend's build command receives `BUILD_ID` too; the kit adds `/_turbo-vibe/build-id` to its output so `smoke` can check the page as well.

## Credentials

`apply` and `deploy` read these environment variables and stop, naming any that are missing, before they run anything (`deploy` needs only the `CLOUDFLARE_*` ones):

| Variable | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with Workers Scripts: Edit and Containers: Edit (account), Workers Routes: Edit and DNS: Edit (zone) |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account that runs the Workers and holds the state bucket |
| `CLOUDFLARE_ZONE_ID` | the zone of the project's `domain` |
| `TURBO_VIBE_STATE_BUCKET` | an R2 bucket for OpenTofu state, created once by hand |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | an R2 API token with Object Read & Write on that bucket |

OpenTofu 1.10 or later must be on `PATH` as `tofu`. Docker must be available to `deploy`, which builds container images. Add `.turbo-vibe/` to the project's `.gitignore`; `apply` and `deploy` write their working files there.
