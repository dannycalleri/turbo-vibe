import type { Config } from "../config/schema.js";
import { environmentSecrets } from "../deploy.js";
import { appPublic } from "../secrets.js";
import { kindOf } from "../setup.js";
import { cliRange } from "../version.js";
import { stateBucketName } from "./cloudflare.js";

const cloudflareDashboard = "https://dash.cloudflare.com/?to=/:account";

export function setupSteps(
  config: Config,
  environments: readonly string[],
): string {
  const services = Object.values(config.services);
  const container = services.some(
    (service) => service.target === "cloudflare-container",
  );
  const database = services.find((service) => service.kind === "database");
  const identity = services.some((service) => service.kind === "identity");
  const vercel = services.some((service) =>
    service.target.startsWith("vercel-"),
  );
  const paidDatabase =
    database?.kind === "database" &&
    (database.plan === "paid" ||
      database.staging === "branch" ||
      config.previews === true);

  const accounts = [
    "GitHub: the repository, and the GitHub CLI signed in with `gh auth login` (https://cli.github.com)",
    `Cloudflare: an account, and the registered domain that holds ${config.domain} (at Cloudflare or any registrar)${container ? "; the Workers Paid plan, which Containers need" : ""}`,
    ...(database
      ? [
          `Supabase: an organization, on the ${paidDatabase ? "Pro plan (the config asks for plan: paid, staging: branch or previews)" : "Free plan or higher"}`,
        ]
      : []),
    ...(identity
      ? [
          "WorkOS: a workspace; production needs billing, which a team admin adds",
        ]
      : []),
    ...(vercel
      ? ["Vercel: an account or team; a commercial project needs the Pro plan"]
      : []),
  ];

  const steps = [
    ...(container
      ? [`Subscribe to Workers Paid: ${cloudflareDashboard}/workers/plans`]
      : []),
    `Enable R2 once on the account: ${cloudflareDashboard}/r2/overview`,
    `Create the Cloudflare bootstrap token, owned by the account, with only Account API Tokens: Edit and a one-day expiry: ${cloudflareDashboard}/api-tokens`,
    "Copy the Cloudflare account ID: the part after dash.cloudflare.com/ in the dashboard's address",
    "If setup adds the zone to Cloudflare, set the zone's nameservers at your registrar when it prints them; that moves DNS for the whole zone",
    ...(database
      ? [
          "Create the Supabase organization: https://supabase.com/dashboard/new",
          "Create a Supabase access token: https://supabase.com/dashboard/account/tokens",
        ]
      : []),
    ...(identity
      ? [
          "Copy each WorkOS environment's API key and client ID (the client ID is on the application page linked from the key's row): https://dashboard.workos.com/api-keys",
        ]
      : []),
    ...(vercel
      ? [
          "Create a Vercel access token, scoped to the team: https://vercel.com/account/settings/tokens",
        ]
      : []),
  ];

  const workers = services.some((service) =>
    service.target.startsWith("cloudflare-"),
  );
  const limits = [
    ...(workers
      ? [
          `Every environment's Cloudflare token can deploy any Worker in the account, production's included${container ? ", and change any container application, production's image included" : ""}`,
        ]
      : []),
    `Every environment's Cloudflare token can edit the zone's DNS records${workers ? " and routes" : ""}, so it could point production's hostnames elsewhere`,
    ...(database
      ? [
          "The Supabase access token reaches every project in its organization; a separate organization for production keeps them apart",
        ]
      : []),
    ...(vercel
      ? [
          "The Vercel token reaches every project in its team; a separate team for production keeps them apart",
        ]
      : []),
    ...(identity
      ? ["Staging and previews share the WorkOS staging environment's key"]
      : []),
    ...(config.previews
      ? [
          "Previews run pull request code with the preview's tokens, which reach as far as every line above",
        ]
      : []),
    "On a private GitHub repository without GitHub Pro, Team or Enterprise, there are no deployment-branch rules, so a workflow on any branch could ask for staging's or production's secrets",
    "Keeping staging and previews away from production's Workers, containers and DNS needs production in its own Cloudflare account and zone, which turbo-vibe does not support yet",
  ];

  return [
    "Accounts and plans",
    ...accounts.map((line, index) => `  ${index + 1}. ${line}`),
    "",
    "Steps only a person can do",
    ...steps.map((line, index) => `  ${index + 1}. ${line}`),
    "",
    `Then, in a terminal: npx @turbo-vibe/cli@${cliRange} setup`,
    "",
    "State buckets setup finds or creates, one per environment",
    ...environments.map(
      (environment) =>
        `  ${environment}: ${stateBucketName(config, environment)}${environment === "production" ? ` (and read-only access to ${stateBucketName(config, "staging")}, for the builds it promotes)` : ""}`,
    ),
    "",
    "Secrets setup stores in each GitHub environment",
    ...environments.map(
      (environment) =>
        `  ${environment}: ${environmentSecrets(config, kindOf(environment)).join(", ")}`,
    ),
    ...(appPublic(config).size > 0
      ? [
          "",
          "Public values setup stores as variables in each GitHub environment",
          ...environments.map(
            (environment) =>
              `  ${environment}: ${[...appPublic(config).keys()].sort().join(", ")}`,
          ),
        ]
      : []),
    "",
    "What one Cloudflare account leaves shared",
    ...limits.map((line) => `  - ${line}`),
    "",
  ].join("\n");
}
