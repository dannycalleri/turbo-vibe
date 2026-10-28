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
| `access.emails` | list of email addresses | none | Make the environment private. On a hostname that Cloudflare serves, Cloudflare Access lets in only these people: it sends a one-time code to the address they enter. `/_turbo-vibe/build-id` and `/_turbo-vibe/health` stay public there, so the smoke test can read them (not on an environment made private with turbo-vibe 1.0), and the account needs Zero Trust. On a hostname that Vercel serves, Vercel Authentication lets in the members of the Vercel team, so each listed person needs a place in it. A preview is private when staging is. See the reference's [Private environments](reference.md#private-environments). |
| `analytics` | boolean | `false` | Count visits with [Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/), which sets no cookies. `apply` creates a site for the environment's hostname, and each deploy adds its beacon to the pages of a `cloudflare-static` frontend, in this environment's copy only. Previews never count. See the reference's [Analytics](reference.md#analytics). |

## Services

Paths are relative to the config file, and commands run in its directory unless a row says otherwise. Every service has a `kind` and a `target`. The kind decides which fields it takes; the target decides where it runs.

| `kind` | Targets |
|---|---|
| `backend` | `cloudflare-container` |
| `frontend` | `cloudflare-static`, `vercel-static` (beta), `vercel-nextjs` (beta) |
| `database` | `supabase` |
| `identity` | `workos` |

`cloudflare-static` runs on Workers Static Assets, which Cloudflare recommends instead of Pages for new projects. With `serve_with`, the page and the API share one Worker and one origin, so the page calls the API without CORS and the sign-in cookie reaches it.

A backend is served under its `paths`, `/api/` by default, and a frontend under `/`.

### `kind: backend`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `paths` | list of paths that start and end with `/` | `[/api/]` | The path prefixes that reach the backend, such as `[/api/, /auth/]`. `[/]` gives the backend its whole hostname, so no frontend may share that hostname. The kit forwards each path as the browser sent it. A change on a deployed project replaces routes, so `apply` needs `--allow-deletions` once in each environment. |
| `secrets` | list of names | none | The application's own secrets, such as `[STRIPE_SECRET_KEY]`. Names only: each value lives in the GitHub environment it belongs to, and reaches the running container as an environment variable of that name. See the reference's [Your application's own secrets](reference.md#your-applications-own-secrets). |
| `build.dockerfile` | path | required | The Dockerfile, relative to the config file. |
| `build.context` | path | the Dockerfile's directory | The Docker build context. |
| `build.test` | command | none | Run by `turbo-vibe test` before anything is built. |
| `build.secrets` | list of names | none | Secrets only the build needs, such as `[NPM_TOKEN]`, passed to `docker build` as BuildKit secrets. One value for every environment, stored as a repository secret. See the reference's [Secrets only the build needs](reference.md#secrets-only-the-build-needs). |
| `container.instance_type` | `lite`, `basic`, `standard-1` … `standard-4` | `lite` | The Cloudflare container size. |
| `container.sleep_after` | duration such as `30s`, `5m`, `1h` | `5m` | Idle time before the container sleeps. |
| `container.max_instances` | integer ≥ 1 | `1` | How many container instances may run. |
| `container.health` | a path such as `/ready` | none | A readiness route. After every deploy the kit asks the container for it, and only HTTP 2xx passes. Without it, the kit asks for `/`, and any answer below HTTP 500 passes. It must answer without the database. |
| `container.port` | integer from 1 to 65535 | the Dockerfile's `EXPOSE`, else `8080` | The port the server listens on. Without it, the kit reads the TCP port of the last `EXPOSE` that has one in the Dockerfile's final stage, or in the stage it builds on. The kit also gives the port as `PORT`. |
| `container.instance_from` | `query:<parameter>` or `header:<name>` | none | Route each request to the instance named by that query parameter or header; requests without it reach the `default` instance. |

### `kind: frontend`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `serve_with` | service name | none | `cloudflare-static` only: serve the files from that backend's Worker, on the same hostname. |
| `not_found` | `spa` or `404-page` | `spa` | `cloudflare-static` only: the answer to a path that matches no built file. `spa` answers `200` with `index.html`, for a single-page app that routes in the browser. `404-page` answers `404` with the nearest `404.html`, for a site with one file per page. See the reference's [Missing pages](reference.md#missing-pages). |
| `public` | list of names | none | Public values the build inlines, such as `[NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY]`. The build sees a placeholder; each deploy puts that environment's value into a copy of the built files. See the reference's [Public values in a frontend build](reference.md#public-values-in-a-frontend-build). |
| `secrets` | list of names | none | `vercel-nextjs` only: the app's own secrets, which its server code reads; each environment's value is set on that environment's Vercel project. |
| `build.command` | command | required | Builds the frontend. For `vercel-nextjs` it runs in `build.root`. |
| `build.output` | path | required for `cloudflare-static` and `vercel-static` | The directory the build writes. |
| `build.root` | path | `.` | `vercel-nextjs` only: the Next.js app's directory, where `build.command` runs. |
| `build.test` | command | none | Run by `turbo-vibe test`. |
| `build.secrets` | list of names | none | Secrets only the build command needs, such as `[SENTRY_AUTH_TOKEN]`, in its environment. One value for every environment, stored as a repository secret; the kit refuses to ship built files that hold one. |

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
| `callback_path` | path under one of the backend's `paths` | `/api/auth/callback` | Where the backend receives the sign-in callback; registered per environment. |

## Rules only the CLI checks

These need more than one field, or the list of adapters, so the JSON Schema cannot express them. `turbo-vibe plan` reports each with its line, except the last, which only `turbo-vibe preview deploy` checks.

- **Targets match kinds.** A service's target must exist and run that kind of service.
- **One of each, for databases and sign-in.** A project has at most one `database` and one `identity` service.
- **No two services at one path.** A project has at most one backend, and two frontends would both be served at `/`.
- **`paths`.** A backend with `/` in its `paths` takes the whole hostname, so no frontend may share it. A sign-in `callback_path` must start with one of the backend's `paths`, or with `/api/` when the project has no backend. The schema also refuses a path with a `.` or `..` segment, and one under `/_turbo-vibe/`, which the kit answers itself.
- **`serve_with`** names a backend service, and only `cloudflare-static` takes it.
- **`not_found`** applies only to `cloudflare-static`.
- **`build.output` and `build.root`.** `cloudflare-static` and `vercel-static` need `build.output`; `vercel-nextjs` builds its own output, so it takes `build.root` and refuses `build.output`; the other frontend targets refuse `build.root`.
- **Secret and public names.** Each name in `secrets`, `public` and `build.secrets` is a variable name (capital letters, digits and underscores, starting with a letter), appears once in a service's list, does not start with `GITHUB_` or `TURBO_VIBE_`, and is not a name the kit sets in a service or keeps for its own credentials. The error names the conflict and suggests a prefixed name, such as `APP_AWS_ACCESS_KEY_ID`. A name belongs to one kind of list: runtime secret, public value or build secret. Of the frontends, only `vercel-nextjs` takes `secrets`, for its server code; a static frontend's build is public.
- **Instance routing.** `instance_from` needs `max_instances` of 3 or more, because during a deploy the previous build's instances still count until they stop, and `max_instances` above 1 needs `instance_from`.
- **`staging: branch`** needs `plan: paid`.
- **Previews with a database** need `plan: paid`. `preview deploy` does not fail without it: it prints why there is no preview and exits successfully, so a pull request still passes.
- **Private environments.** `access` refuses a frontend on `vercel-static` or `vercel-nextjs` beside a backend on a Cloudflare target, because the page calls the backend from another origin: that layout cannot be private yet.
- **Analytics** needs a `cloudflare-static` frontend, whose pages carry the beacon.
- **Hostnames.** No two environments share a hostname, nor an environment and an API hostname, and an API hostname must be under the frontend hostname's parent domain, so the browser treats the two as one site and sends the API's sign-in cookie with the frontend's requests.
