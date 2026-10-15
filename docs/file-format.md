# The `turbo-vibe.yaml` file format

One file at the root of a repository describes a project's services and where each runs. This page lists every field. The same rules are published as a JSON Schema, generated from the CLI's own validation:

```
https://unpkg.com/@turbo-vibe/cli@1/schema/turbo-vibe.schema.json
```

`init` writes a first line that points editors at it, so an editor with YAML language support (VS Code's YAML extension, JetBrains IDEs, Zed) flags unknown fields and completes values without running the CLI:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@turbo-vibe/cli@1/schema/turbo-vibe.schema.json
```

The schema checks each field on its own. The rules that relate fields to each other are checked only by the CLI, in `turbo-vibe plan` and every other command that reads the file; they are listed at the end.

## Top level

| Field | Type | Default | Meaning |
|---|---|---|---|
| `version` | `1` | required | The file format version. |
| `project` | name | required | The project's name, used in every resource the kit creates (`<project>-<service>-<environment>` for Workers). Lowercase letters, digits and hyphens, starting with a letter, at most 63 characters. |
| `domain` | hostname | required | Production's hostname. |
| `previews` | boolean | `false` | Allow `turbo-vibe preview deploy` for pull requests, in the `preview` GitHub environment with its own state bucket and tokens. A project with a database also needs `plan: paid`, because each preview's database is a Supabase branch. Within one Cloudflare account, previews' tokens still reach production's Workers and DNS; see the bootstrap checklist's [What one account leaves shared](bootstrap.md#8-what-one-account-leaves-shared). |
| `environments` | mapping | see below | Hostnames per environment. |
| `services` | mapping of name → service | required, at least one | The services, keyed by a name (same rules as `project`). |

## `environments.staging` and `environments.production`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `hostname` | hostname | `staging.<domain>` for staging, `<domain>` for production | Where the environment's frontend and backend are served. Keep it one level below the zone, such as `staging-app.example.com`: Cloudflare's free certificate covers only the apex and first-level names, so the staging default suits only a domain at the apex. `init` writes a staging hostname that follows this rule. |
| `api_hostname` | hostname | `api.<hostname>` | The backend's own hostname, used only when the frontend runs on Vercel. Set it when `api.<hostname>` would be two levels below the zone. It must be under the same parent domain as `hostname`. |

## Services

Paths are relative to the config file, and commands run in its directory unless a row says otherwise. Every service has a `kind` and a `target`. The kind decides which fields it takes; the target decides where it runs.

| `kind` | Targets |
|---|---|
| `backend` | `cloudflare-container` |
| `frontend` | `cloudflare-static`, `vercel-static` (beta), `vercel-nextjs` (beta) |
| `database` | `supabase` |
| `identity` | `workos` |

A backend is served under `/api/` and a frontend under `/`.

### `kind: backend`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `secrets` | list of names | none | The application's own secrets, such as `[STRIPE_SECRET_KEY]`. Names only: each value lives in the GitHub environment it belongs to, and reaches the running container as an environment variable of that name. See the README's [Your application's own secrets](../README.md#your-applications-own-secrets). |
| `build.dockerfile` | path | required | The Dockerfile, relative to the config file. |
| `build.context` | path | the Dockerfile's directory | The Docker build context. |
| `build.test` | command | none | Run by `turbo-vibe test` before anything is built. |
| `container.instance_type` | `lite`, `basic`, `standard-1` … `standard-4` | `lite` | The Cloudflare container size. |
| `container.sleep_after` | duration such as `30s`, `5m`, `1h` | `5m` | Idle time before the container sleeps. |
| `container.max_instances` | integer ≥ 1 | `1` | How many container instances may run. |
| `container.instance_from` | `query:<parameter>` or `header:<name>` | none | Route each request to the instance named by that query parameter or header; requests without it reach the `default` instance. |

### `kind: frontend`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `serve_with` | service name | none | `cloudflare-static` only: serve the files from that backend's Worker, on the same hostname. |
| `public` | list of names | none | Public values the build inlines, such as `[NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY]`. The build sees a placeholder; each deploy puts that environment's value into a copy of the built files. See the README's [Public values in a frontend build](../README.md#public-values-in-a-frontend-build). |
| `secrets` | list of names | none | `vercel-nextjs` only: the app's own secrets, which its server code reads; each environment's value is set on that environment's Vercel project. |
| `build.command` | command | required | Builds the frontend. For `vercel-nextjs` it runs in `build.root`. |
| `build.output` | path | required for `cloudflare-static` and `vercel-static` | The directory the build writes. |
| `build.root` | path | `.` | `vercel-nextjs` only: the Next.js app's directory, where `build.command` runs. |
| `build.test` | command | none | Run by `turbo-vibe test`. |

### `kind: database`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `organization` | string | `SUPABASE_ORGANIZATION` | The Supabase organization's slug. Leave it out to keep the slug out of the repository; `plan --env`, `apply` and `check` then read it from `SUPABASE_ORGANIZATION`. |
| `region` | string | required | The Supabase region, such as `eu-central-1`. |
| `plan` | `free` or `paid` | `free` | The organization's plan; `check` compares it with the real one. |
| `staging` | `project` or `branch` | `project` | Staging gets its own project, or a persistent branch of production's (paid plans). |
| `workdir` | path | `.` | The directory holding `supabase/migrations/`. |

### `kind: identity`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `callback_path` | path under `/api/` | `/api/auth/callback` | Where the backend receives the sign-in callback; registered per environment. |

## Rules only the CLI checks

These need more than one field, or the list of adapters, so the JSON Schema cannot express them. `turbo-vibe plan` reports each with its line, except the last, which only `turbo-vibe preview deploy` checks.

- **Targets match kinds.** A service's target must exist and run that kind of service.
- **One of each, for databases and sign-in.** A project has at most one `database` and one `identity` service.
- **No two services at one path.** Two backends, or two frontends, would both be served at `/api/` or `/`.
- **`serve_with`** names a backend service, and only `cloudflare-static` takes it.
- **`build.output` and `build.root`.** `cloudflare-static` and `vercel-static` need `build.output`; `vercel-nextjs` builds its own output, so it takes `build.root` and refuses `build.output`; the other frontend targets refuse `build.root`.
- **Secret and public names.** Each name in `secrets` and `public` is a variable name (capital letters, digits and underscores, starting with a letter), appears once in a service's list, does not start with `GITHUB_` or `TURBO_VIBE_`, and is not a name the kit sets in a service or keeps for its own credentials. The error names the conflict and suggests a prefixed name, such as `APP_AWS_ACCESS_KEY_ID`. A name is either secret or public, not both. Of the frontends, only `vercel-nextjs` takes `secrets`, for its server code; a static frontend's build is public.
- **Instance routing.** `instance_from` needs `max_instances` of 2 or more, and `max_instances` above 1 needs `instance_from`.
- **`staging: branch`** needs `plan: paid`.
- **Previews with a database** need `plan: paid`. `preview deploy` does not fail without it: it prints why there is no preview and exits successfully, so a pull request still passes.
- **Hostnames.** No two environments share a hostname, nor an environment and an API hostname, and an API hostname must be under the frontend hostname's parent domain, so the browser treats the two as one site and sends the API's sign-in cookie with the frontend's requests.
