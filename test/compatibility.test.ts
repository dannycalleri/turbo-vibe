import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adapters } from "../src/adapters/index.js";
import {
  compatibility,
  exampleTargets,
  lastPasses,
  type Pins,
  readPins,
  runSchema,
} from "../src/compatibility.js";

const pins: Pins = {
  opentofu: "1.13.1",
  packages: { wrangler: "4.148.0", "@cloudflare/containers": "0.3.7" },
  providers: { cloudflare: "5.27.0" },
};
const examples = {
  "python-api": ["cloudflare-container"],
  "vercel-static": ["vercel-static"],
};
const row = (matrix: string, target: string) =>
  matrix.split("\n").find((line) => line.startsWith(`| \`${target}\` |`));

describe("compatibility", () => {
  it("reads pinned versions from package.json, every module's versions.tf, and the reusable workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "turbo-vibe-pins-"));
    await mkdir(join(root, "infra/a"), { recursive: true });
    await mkdir(join(root, "infra/b"), { recursive: true });
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { wrangler: "9.9.9" } }),
    );
    await writeFile(
      join(root, "infra/a/versions.tf"),
      'terraform {\n  required_providers {\n    cloudflare = {\n      source  = "cloudflare/cloudflare"\n      version = "1.2.3"\n    }\n  }\n}\n',
    );
    await writeFile(
      join(root, "infra/b/versions.tf"),
      'terraform {\n  required_version = ">= 1.10"\n  required_providers {\n    supabase = {\n      source  = "supabase/supabase"\n      version = "4.5.6"\n    }\n    random = {\n      source  = "hashicorp/random"\n      version = "7.8.9"\n    }\n  }\n}\n',
    );
    await writeFile(
      join(root, ".github/workflows/deploy.yml"),
      'env:\n  TOFU_VERSION: "1.13.1"\n',
    );
    expect(await readPins(root)).toEqual({
      opentofu: "1.13.1",
      packages: { wrangler: "9.9.9" },
      providers: { cloudflare: "1.2.3", supabase: "4.5.6", random: "7.8.9" },
    });
  });

  it("dates each adapter by the last run in which an example using it passed, keeping that date through a failure", () => {
    const first = compatibility({
      run: {
        date: "2026-10-12",
        examples: { "python-api": "passed", "vercel-static": "passed" },
      },
      examples,
      pins,
    });
    const second = compatibility({
      previous: first,
      run: {
        date: "2026-10-19",
        examples: { "python-api": "passed", "vercel-static": "failed" },
      },
      examples,
      pins,
    });
    expect(row(second, "cloudflare-container")).toMatch(/\| 2026-10-19 \|$/);
    expect(row(second, "vercel-static")).toMatch(/\| 2026-10-12 \|$/);
    expect(row(second, "workos")).toMatch(/\| not yet \|$/);
    expect(lastPasses(second)).toEqual({
      "cloudflare-container": "2026-10-19",
      "vercel-static": "2026-10-12",
    });
  });

  it("has a row for every registered adapter", () => {
    const matrix = compatibility({ examples, pins });
    for (const target of Object.keys(adapters)) {
      expect(row(matrix, target), target).toBeDefined();
    }
  });

  it("refuses a results file that would drop recorded dates", () => {
    expect(runSchema.safeParse({ examples: { a: "passed" } }).success).toBe(
      false,
    );
    expect(
      runSchema.safeParse({ date: "2026-10-12", examples: { a: "success" } })
        .success,
    ).toBe(false);
    expect(
      runSchema.safeParse({ date: "2026-10-12", examples: { a: "failed" } })
        .success,
    ).toBe(true);
  });

  it("dates an example by when it passed, when that is not the run's date, and never moves a date back", () => {
    const earlier = compatibility({
      run: { date: "2026-10-19", examples: { "python-api": "passed" } },
      examples,
      pins,
    });
    const matrix = compatibility({
      previous: earlier,
      run: {
        date: "2026-10-26",
        examples: { "python-api": "passed", "vercel-static": "passed" },
        passedOn: { "python-api": "2026-10-01", "vercel-static": "2026-10-24" },
      },
      examples,
      pins,
    });
    expect(lastPasses(matrix)).toEqual({
      "cloudflare-container": "2026-10-19",
      "vercel-static": "2026-10-24",
    });
  });

  it("lists each adapter's pins and marks beta ones", () => {
    const matrix = compatibility({ examples, pins });
    expect(row(matrix, "cloudflare-container")).toBe(
      "| `cloudflare-container` | stable | wrangler 4.148.0, @cloudflare/containers 0.3.7, OpenTofu 1.13.1, cloudflare provider 5.27.0 | not yet |",
    );
    expect(row(matrix, "vercel-nextjs")).toContain("| beta |");
  });

  it("gives byte-identical output for identical inputs, so an unchanged run commits nothing", () => {
    const run = {
      date: "2026-10-12",
      examples: { "python-api": "passed" as const },
    };
    const matrix = compatibility({ run, examples, pins });
    expect(compatibility({ previous: matrix, run, examples, pins })).toBe(
      matrix,
    );
  });

  it("is committed in step with this release's pins; run `make compatibility` after bumping one", async () => {
    const root = join(import.meta.dirname, "..");
    const committed = await readFile(join(root, "COMPATIBILITY.md"), "utf8");
    expect(
      compatibility({
        previous: committed,
        examples: await exampleTargets(root),
        pins: await readPins(root),
      }),
      "COMPATIBILITY.md is stale: run `make compatibility`",
    ).toBe(committed);
  });
});
