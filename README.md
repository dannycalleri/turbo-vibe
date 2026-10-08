# turbo-vibe

Deploy a project's services from one `turbo-vibe.yaml`.

```sh
npx @turbo-vibe/cli plan
npx @turbo-vibe/cli apply --env staging
```

## Credentials

`apply` reads these environment variables and stops, naming any that are missing, before it runs anything:

| Variable | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with Workers Scripts: Edit (account), Workers Routes: Edit and DNS: Edit (zone) |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account that runs the Workers and holds the state bucket |
| `CLOUDFLARE_ZONE_ID` | the zone of the project's `domain` |
| `TURBO_VIBE_STATE_BUCKET` | an R2 bucket for OpenTofu state, created once by hand |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | an R2 API token with Object Read & Write on that bucket |

OpenTofu 1.10 or later must be on `PATH` as `tofu`. Add `.turbo-vibe/` to the project's `.gitignore`; `apply` writes its working files there.
