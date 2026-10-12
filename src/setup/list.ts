import type { Config } from "../config/schema.js";
import { environmentSecrets } from "../deploy.js";

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
    "Set the zone's nameservers at your registrar when setup prints them",
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

  const secrets = environmentSecrets(config).join(", ");
  return [
    "Accounts and plans",
    ...accounts.map((line, index) => `  ${index + 1}. ${line}`),
    "",
    "Steps only a person can do",
    ...steps.map((line, index) => `  ${index + 1}. ${line}`),
    "",
    "Then, in a terminal: turbo-vibe setup",
    "",
    "Secrets setup stores in each GitHub environment",
    ...environments.map((environment) => `  ${environment}: ${secrets}`),
    "",
  ].join("\n");
}
