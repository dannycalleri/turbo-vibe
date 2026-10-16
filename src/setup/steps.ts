import type { Config } from "../config/schema.js";
import { Cancelled, type Io } from "../io.js";
import { cloudflareSecrets } from "./cloudflare.js";

export interface VendorStep {
  vendor: string;
  plan: (config: Config) => string;
  url: string;
  clicks: readonly string[];
  permissions: string;
  produces: readonly string[];
}

const uses = (config: Config, target: string) =>
  Object.values(config.services).some((service) => service.target === target);

export const cloudflareStep: VendorStep = {
  vendor: "Cloudflare",
  plan: (config) =>
    uses(config, "cloudflare-container")
      ? "Workers Paid, which Containers need"
      : "the Free plan or higher",
  url: "https://dash.cloudflare.com/?to=/:account/api-tokens",
  clicks: [
    'Open Manage Account → Account API Tokens, and click "Create Token"',
    'Next to "Create Custom Token", click "Get started"',
    'Name it "turbo-vibe bootstrap"',
    "Under Permissions, choose Account, Account API Tokens, Edit",
    "Under TTL, set the end date to tomorrow",
    'Click "Continue to summary", then "Create Token", and copy the token',
  ],
  permissions:
    "Account API Tokens: Edit, and nothing else; setup creates every other token from it",
  produces: cloudflareSecrets,
};

export const vendorSteps: readonly VendorStep[] = [cloudflareStep];

export function stepsToAsk(
  needed: readonly string[],
  lacking: (names: readonly string[]) => boolean,
): VendorStep[] {
  return vendorSteps.filter(
    (step) =>
      step.produces.some((name) => needed.includes(name)) &&
      lacking(step.produces),
  );
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
      `  Plan: ${step.plan(config)}`,
      ...step.clicks.map((click, index) => `  ${index + 1}. ${click}`),
      `  Permissions: ${step.permissions}`,
      `  ${step.url}`,
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
