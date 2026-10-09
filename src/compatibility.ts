import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { adapters } from "./adapters/index.js";

export const runSchema = z.strictObject({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date like 2026-10-12"),
  examples: z.record(z.string(), z.enum(["passed", "failed"])),
});
export type Run = z.infer<typeof runSchema>;

const tools: Record<string, { packages: string[]; providers: string[] }> = {
  "cloudflare-container": {
    packages: ["wrangler", "@cloudflare/containers"],
    providers: ["cloudflare"],
  },
  "cloudflare-static": { packages: ["wrangler"], providers: ["cloudflare"] },
  supabase: { packages: ["supabase"], providers: ["supabase", "random"] },
  workos: { packages: [], providers: ["workos"] },
  "vercel-static": {
    packages: ["vercel"],
    providers: ["vercel", "cloudflare"],
  },
  "vercel-nextjs": {
    packages: ["vercel"],
    providers: ["vercel", "cloudflare"],
  },
};

export interface Pins {
  opentofu: string;
  packages: Record<string, string>;
  providers: Record<string, string>;
}

export async function readPins(root: string): Promise<Pins> {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const providers: Record<string, string> = {};
  for (const module of await readdir(join(root, "infra"))) {
    const versions = await readFile(
      join(root, "infra", module, "versions.tf"),
      "utf8",
    );
    for (const [, name, version] of versions.matchAll(
      /(\w+)\s*=\s*\{[^}]*?version\s*=\s*"([^"]+)"/g,
    )) {
      if (name && version) providers[name] = version;
    }
  }
  const workflow = parse(
    await readFile(join(root, ".github/workflows/deploy.yml"), "utf8"),
  ) as { env?: { TOFU_VERSION?: string } };
  return {
    opentofu: workflow.env?.TOFU_VERSION ?? "unknown",
    packages: manifest.dependencies ?? {},
    providers,
  };
}

export async function exampleTargets(
  root: string,
): Promise<Record<string, string[]>> {
  const examples: Record<string, string[]> = {};
  const entries = await readdir(join(root, "examples"), {
    withFileTypes: true,
  });
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const config = parse(
      await readFile(
        join(root, "examples", entry.name, "turbo-vibe.yaml"),
        "utf8",
      ),
    ) as { services?: Record<string, { target?: string }> };
    examples[entry.name] = [
      ...new Set(
        Object.values(config.services ?? {}).flatMap((service) =>
          service.target ? [service.target] : [],
        ),
      ),
    ];
  }
  return examples;
}

const names: Record<string, string> = {
  supabase: "Supabase CLI",
  vercel: "Vercel CLI",
};

const stateMarker = /<!-- turbo-vibe-compatibility: (\{.*\}) -->/;

export function lastPasses(
  previous: string | undefined,
): Record<string, string> {
  const match = previous?.match(stateMarker);
  return match?.[1] ? (JSON.parse(match[1]) as Record<string, string>) : {};
}

export function compatibility({
  previous,
  run,
  examples,
  pins,
}: {
  previous?: string;
  run?: Run;
  examples: Record<string, string[]>;
  pins: Pins;
}): string {
  const passes = lastPasses(previous);
  for (const [example, outcome] of Object.entries(run?.examples ?? {})) {
    if (outcome !== "passed" || !run) continue;
    for (const target of examples[example] ?? []) passes[target] = run.date;
  }
  const rows = Object.keys(adapters).map((target) => {
    const adapterTools = tools[target];
    if (!adapterTools) {
      throw new Error(`no pinned tools listed for adapter ${target}`);
    }
    const { packages, providers } = adapterTools;
    const pinned = [
      ...packages.map(
        (name) => `${names[name] ?? name} ${pins.packages[name] ?? "?"}`,
      ),
      `OpenTofu ${pins.opentofu}`,
      ...providers.map(
        (name) => `${name} provider ${pins.providers[name] ?? "?"}`,
      ),
    ].join(", ");
    const stability = adapters[target]?.stability ?? "stable";
    return `| \`${target}\` | ${stability} | ${pinned} | ${passes[target] ?? "not yet"} |`;
  });
  const sortedPasses = Object.fromEntries(
    Object.entries(passes).sort(([a], [b]) => a.localeCompare(b)),
  );
  return [
    "# Compatibility",
    "",
    "Every week, and on demand, the kit's `evidence` workflow deploys each example under `examples/` to real vendor accounts, smoke-tests it, and removes it. This table is generated from those runs: for each adapter, the tool and provider versions this release pins, and the last date an example using it passed. Beta adapters are supported, with less live history than the others.",
    "",
    "| Adapter | Stability | Pinned versions | Last live pass |",
    "|---|---|---|---|",
    ...rows,
    "",
    `<!-- turbo-vibe-compatibility: ${JSON.stringify(sortedPasses)} -->`,
    "",
  ].join("\n");
}
