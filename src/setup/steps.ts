import type { Config } from "../config/schema.js";
import { Cancelled, type Io } from "../io.js";
import { cloudflareSecrets } from "./cloudflare.js";

export interface VendorStep {
  vendor: string;
  neededBy: string;
  plan: (config: Config) => string;
  url: string;
  clicks: readonly string[];
  permissions: string;
  produces: readonly string[];
}

const uses = (config: Config, target: string) =>
  Object.values(config.services).some((service) => service.target === target);

// Cloudflare's account-owned token templates prefill the name and permissions, not the expiry or resources.
export const bootstrapTokenUrl = `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(
  JSON.stringify([{ key: "account_api_tokens", type: "edit" }]),
)}&name=${encodeURIComponent("turbo-vibe bootstrap")}`;

export const cloudflareStep: VendorStep = {
  vendor: "Cloudflare",
  neededBy: "every project",
  plan: (config) =>
    uses(config, "cloudflare-container")
      ? "Workers Paid, which Containers need"
      : "the Free plan or higher",
  url: bootstrapTokenUrl,
  clicks: [
    'Open the page below: it fills in the name "turbo-vibe bootstrap" and the permission Account API Tokens: Edit',
    "If the permission is missing, choose Account, Account API Tokens, Edit under Permissions",
    "Under TTL, set the end date to tomorrow",
    'Click "Continue to summary", then "Create Token", and copy the token',
  ],
  permissions:
    "Account API Tokens: Edit, and nothing else; setup creates every other token from it",
  produces: cloudflareSecrets,
};

export function needsPaidSupabase(config: Config): boolean {
  return Object.values(config.services).some(
    (service) =>
      service.kind === "database" &&
      (service.plan === "paid" ||
        service.staging === "branch" ||
        config.previews === true),
  );
}

export const supabaseStep: VendorStep = {
  vendor: "Supabase",
  neededBy: "a `supabase` database",
  plan: (config) =>
    needsPaidSupabase(config)
      ? "Pro, because the config asks for plan: paid, staging: branch or previews"
      : "the Free plan or higher",
  url: "https://supabase.com/dashboard/account/tokens",
  clicks: [
    'Click "Generate new token"',
    'Name it "turbo-vibe" and choose an expiry',
    'Click "Generate token", and copy the token',
  ],
  permissions:
    "a personal access token reaches every organization you belong to; setup lists them and you choose one",
  produces: ["SUPABASE_ACCESS_TOKEN", "SUPABASE_ORGANIZATION"],
};

export const vercelStep: VendorStep = {
  vendor: "Vercel",
  neededBy: "a `vercel-static` or `vercel-nextjs` frontend",
  plan: () => "Hobby, or Pro for a commercial project",
  url: "https://vercel.com/account/settings/tokens",
  clicks: [
    'Under "Create Token", name it "turbo-vibe"',
    "Under Scope, choose the team that will own the projects",
    'Choose an expiration, click "Create", and copy the token',
  ],
  permissions: "scoped to the one team that owns the projects",
  produces: ["VERCEL_API_TOKEN", "VERCEL_TEAM_ID"],
};

export const workosStep: VendorStep = {
  vendor: "WorkOS",
  neededBy: "a `workos` identity service",
  plan: () => "production needs billing, which a team admin adds",
  url: "https://dashboard.workos.com/api-keys",
  clicks: [
    "Choose the environment at the top left: Staging for staging and previews, Production for production",
    "On API Keys, copy the secret key; a production key is shown only when it is created",
    "Open the application linked from the key's row, and copy its Client ID",
  ],
  permissions:
    "the environment's own secret key: staging's starts with sk_test_, production's with sk_live_",
  produces: ["WORKOS_API_KEY", "WORKOS_CLIENT_ID"],
};

export const vendorSteps: readonly VendorStep[] = [
  cloudflareStep,
  supabaseStep,
  vercelStep,
  workosStep,
];

export function stepsFor(needed: readonly string[]): VendorStep[] {
  return vendorSteps.filter((step) =>
    step.produces.some((name) => needed.includes(name)),
  );
}

export function stepsToAsk(
  needed: readonly string[],
  lacking: (names: readonly string[]) => boolean,
): VendorStep[] {
  return stepsFor(needed).filter((step) => lacking(step.produces));
}

export function stepLines(step: VendorStep, config: Config): string[] {
  return [
    `  Plan: ${step.plan(config)}`,
    ...step.clicks.map((click, index) => `  ${index + 1}. ${click}`),
    `  Permissions: ${step.permissions}`,
    `  ${step.url}`,
  ];
}

export async function openInBrowser(url: string, io: Io): Promise<boolean> {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    return (
      (await io.run(command as string, args, { cwd: io.cwd, env: io.env })) ===
      0
    );
  } catch {
    return false;
  }
}

export async function showStep(
  step: VendorStep,
  position: number,
  total: number,
  config: Config,
  io: Io,
): Promise<void> {
  io.stdout(
    [
      "",
      `Step ${position} of ${total} · ${step.vendor}`,
      ...stepLines(step, config),
      "",
    ].join("\n"),
  );
  if (!io.prompts) return;
  const open = await io.prompts.confirm("Open this page in your browser?");
  if (open === undefined) throw new Cancelled();
  if (!open) return;
  if (!(await openInBrowser(step.url, io)))
    io.stdout("could not open a browser; open the address above\n");
}
