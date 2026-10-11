import type { Config, EnvironmentName } from "./config/schema.js";
import { contributions } from "./infrastructure.js";

export type Action = "create" | "update" | "replace" | "delete";

export interface Change {
  address: string;
  action: Action;
  owners: string[];
}

export interface TofuPlan {
  resource_changes?: {
    address: string;
    mode?: string;
    change: { actions: string[] };
  }[];
}

const single: readonly string[] = ["create", "update", "delete"];

export function classify(actions: readonly string[]): Action | undefined {
  if (
    actions.length === 2 &&
    actions.includes("create") &&
    actions.includes("delete")
  ) {
    return "replace";
  }
  const [only] = actions;
  if (actions.length === 1 && only && single.includes(only)) {
    return only as Action;
  }
  return undefined;
}

const key = (resource: string, name: string) =>
  `${resource}[${JSON.stringify(name)}]`;

export function owners(
  config: Config,
  environment: EnvironmentName,
): { exact: Map<string, string[]>; modules: Map<string, string> } {
  const exact = new Map<string, string[]>();
  const modules = new Map<string, string>();
  const own = (address: string, service: string) =>
    exact.set(address, [...new Set([...(exact.get(address) ?? []), service])]);
  for (const [service, infrastructure] of contributions(config, environment)) {
    const { cloudflare, vercel, supabase, workos } = infrastructure;
    for (const [worker, { routes }] of Object.entries(
      cloudflare?.workers ?? {},
    )) {
      own(key("module.cloudflare.cloudflare_worker.this", worker), service);
      own(
        key("module.cloudflare.cloudflare_worker_version.placeholder", worker),
        service,
      );
      for (const route of routes) {
        own(
          key("module.cloudflare.cloudflare_workers_route.this", route),
          service,
        );
      }
    }
    for (const hostname of cloudflare?.hostnames ?? []) {
      own(
        key("module.cloudflare.cloudflare_dns_record.this", hostname),
        service,
      );
    }
    for (const hostname of Object.keys(cloudflare?.cnames ?? {})) {
      own(
        key("module.cloudflare.cloudflare_dns_record.cname", hostname),
        service,
      );
    }
    for (const [project, settings] of Object.entries(vercel?.projects ?? {})) {
      own(key("module.vercel.vercel_project.this", project), service);
      own(key("module.vercel.vercel_project_domain.this", project), service);
      for (const variable of Object.keys(settings.environment)) {
        own(
          key(
            "module.vercel.vercel_project_environment_variable.this",
            `${project}/${variable}`,
          ),
          service,
        );
      }
    }
    for (const name of Object.keys(supabase ?? {})) {
      modules.set(`module.supabase_${name}.`, service);
    }
    for (const name of Object.keys(workos ?? {})) {
      modules.set(`module.workos_${name}.`, service);
    }
  }
  return { exact, modules };
}

export function summarize(
  plan: TofuPlan,
  { exact, modules }: ReturnType<typeof owners>,
): Change[] {
  const changes: Change[] = [];
  for (const resource of plan.resource_changes ?? []) {
    if (resource.mode === "data") continue;
    const action = classify(resource.change.actions);
    if (!action) continue;
    const module = [...modules.keys()].find((prefix) =>
      resource.address.startsWith(prefix),
    );
    const owner = module ? modules.get(module) : undefined;
    changes.push({
      address: resource.address,
      action,
      owners: exact.get(resource.address) ?? (owner ? [owner] : []),
    });
  }
  return changes;
}

const symbol: Record<Action, string> = {
  create: "+",
  update: "~",
  replace: "-/+",
  delete: "-",
};

const ownerLabel = (environment: EnvironmentName, change: Change) =>
  change.owners.length > 0
    ? change.owners.join(", ")
    : `${environment}, no service`;

export function diagnostics(planOutput: string): string[] {
  const messages: string[] = [];
  for (const line of planOutput.split("\n")) {
    if (!line.startsWith("{")) continue;
    const entry = JSON.parse(line) as {
      type?: string;
      "@level"?: string;
      diagnostic?: { summary?: string; detail?: string };
    };
    if (entry.type !== "diagnostic" || !entry.diagnostic) continue;
    const { summary = "", detail } = entry.diagnostic;
    messages.push(
      `${entry["@level"] === "error" ? "error" : "warning"}: ${summary}${detail ? `\n  ${detail.replaceAll("\n", "\n  ")}` : ""}`,
    );
  }
  return messages;
}

export function formatChanges(
  environment: EnvironmentName,
  changes: readonly Change[],
): string {
  if (changes.length === 0) return `${environment}: no changes`;
  const count = (action: Action) =>
    changes.filter((change) => change.action === action).length;
  const lines = [
    `${environment}: ${count("create")} to create, ${count("update")} to change, ${count("replace")} to replace, ${count("delete")} to delete`,
  ];
  const groups = new Map<string, Change[]>();
  for (const change of changes) {
    if (change.action === "replace" || change.action === "delete") continue;
    const label = ownerLabel(environment, change);
    groups.set(label, [...(groups.get(label) ?? []), change]);
  }
  for (const [label, group] of groups) {
    lines.push("", label);
    for (const change of group) {
      lines.push(`  ${symbol[change.action]} ${change.address}`);
    }
  }
  const destructive = changes.filter(
    (change) => change.action === "replace" || change.action === "delete",
  );
  if (destructive.length > 0) {
    lines.push("", "Deletions and replacements:");
    for (const change of destructive) {
      lines.push(
        `  ${symbol[change.action]} ${change.address} (${ownerLabel(environment, change)})`,
      );
    }
  }
  return lines.join("\n");
}
