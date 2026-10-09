import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { parseConfig } from "../src/config/load.js";
import { type Answers, choices, configFor } from "../src/init.js";
import { derivePlan } from "../src/plan.js";
import { major, version } from "../src/version.js";
import { run } from "./harness.js";

const answers = (overrides: Partial<Answers> = {}): Answers => ({
  name: "shop",
  domain: "shop.example.com",
  backend: "cloudflare-container",
  frontend: "cloudflare-static",
  database: "none",
  identity: "none",
  assistant: "none",
  ...overrides,
});

describe("configFor", () => {
  it("turns every combination of answers into a config that validates", () => {
    for (const backend of choices.backend) {
      for (const frontend of choices.frontend) {
        for (const database of choices.database) {
          for (const identity of choices.identity) {
            if (backend === "none" && frontend === "none") continue;
            const result = parseConfig(
              configFor(answers({ backend, frontend, database, identity })),
            );
            expect(
              result.ok,
              `${backend} + ${frontend} + ${database} + ${identity}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("serves a Cloudflare page from the API's Worker, one level below the zone", () => {
    const result = parseConfig(configFor(answers()));
    if (!result.ok) throw new Error("invalid");
    expect(result.config.services.web).toMatchObject({ serve_with: "api" });
    expect(derivePlan(result.config).map((plan) => plan.hostname)).toEqual([
      "staging-shop.example.com",
      "shop.example.com",
    ]);
  });

  it("gives a Vercel frontend's API its own one-level hostnames", () => {
    const result = parseConfig(
      configFor(answers({ frontend: "vercel-static" })),
    );
    if (!result.ok) throw new Error("invalid");
    expect(result.config.environments).toEqual({
      staging: {
        hostname: "staging-shop.example.com",
        api_hostname: "api-staging-shop.example.com",
      },
      production: { api_hostname: "api-shop.example.com" },
    });
  });

  it("marks every placeholder it fills in", () => {
    const text = configFor(answers({ database: "supabase" }));
    for (const line of [
      "command: npm ci && npm run build",
      "output: dist",
      "region: us-east-1",
      "organization: your-supabase-org-slug",
    ]) {
      expect(text.split("\n").find((row) => row.includes(line))).toContain("#");
    }
  });

  it("takes a three-label domain as a subdomain, so a multi-part apex such as example.co.uk needs its hostnames edited", () => {
    const result = parseConfig(configFor(answers({ domain: "example.co.uk" })));
    if (!result.ok) throw new Error("invalid");
    expect(result.config.environments?.staging?.hostname).toBe(
      "staging-example.co.uk",
    );
  });

  it("uses plain subdomains under an apex domain", () => {
    const result = parseConfig(
      configFor(answers({ domain: "example.com", frontend: "vercel-static" })),
    );
    if (!result.ok) throw new Error("invalid");
    expect(result.config.environments).toEqual({
      staging: {
        hostname: "staging.example.com",
        api_hostname: "api-staging.example.com",
      },
      production: { api_hostname: "api.example.com" },
    });
  });
});

describe("turbo-vibe init", () => {
  const flags = [
    "--name",
    "shop",
    "--domain",
    "shop.example.com",
    "--backend",
    "cloudflare-container",
    "--frontend",
    "none",
    "--database",
    "supabase",
    "--identity",
    "workos",
    "--assistant",
    "none",
  ];

  it("writes the config and both workflows", async () => {
    const { code, cwd, stdout } = await run(["init", ...flags]);
    expect(code).toBe(0);
    expect(stdout).toContain("wrote turbo-vibe.yaml");
    expect(
      parseConfig(await readFile(join(cwd, "turbo-vibe.yaml"), "utf8")).ok,
    ).toBe(true);
    expect(
      await readFile(join(cwd, ".github/workflows/staging.yml"), "utf8"),
    ).toContain(
      "uses: dannycalleri/turbo-vibe/.github/workflows/deploy.yml@v1",
    );
    expect(
      await readFile(join(cwd, ".github/workflows/production.yml"), "utf8"),
    ).toContain("workflow_dispatch");
  });

  it("stops and leaves an existing config unchanged", async () => {
    const mine = "version: 1\nproject: mine\n";
    const { code, cwd, stderr } = await run(["init", ...flags], {
      "turbo-vibe.yaml": mine,
    });
    expect(code).toBe(1);
    expect(stderr).toBe(
      "turbo-vibe.yaml already exists; nothing was written (pass --force to replace)\n",
    );
    expect(await readFile(join(cwd, "turbo-vibe.yaml"), "utf8")).toBe(mine);
    await expect(
      readFile(join(cwd, ".github/workflows/staging.yml"), "utf8"),
    ).rejects.toThrow();
  });

  it("replaces existing files only with --force", async () => {
    const { code, cwd } = await run(["init", ...flags, "--force"], {
      "turbo-vibe.yaml": "old\n",
    });
    expect(code).toBe(0);
    expect(await readFile(join(cwd, "turbo-vibe.yaml"), "utf8")).toContain(
      "project: shop",
    );
  });

  it("asks for what the flags leave out", async () => {
    const replies: Record<string, string> = {
      "Project name": "shop",
      "Production domain": "shop.example.com",
      "Backend target": "cloudflare-container",
      "Frontend target": "vercel-nextjs",
      "Database target": "none",
      "Identity target": "none",
      "Coding assistant guidance": "none",
    };
    const ask = vi.fn(
      async (question: string) =>
        Object.entries(replies).find(([prefix]) =>
          question.startsWith(prefix),
        )?.[1] ?? "",
    );
    const { code, cwd } = await run(["init"], {}, {}, undefined, undefined, {
      ask,
    });
    expect(code).toBe(0);
    expect(ask).toHaveBeenCalledTimes(7);
    expect(await readFile(join(cwd, "turbo-vibe.yaml"), "utf8")).toContain(
      "target: vercel-nextjs",
    );
  });

  it("points the config at the published schema for the running major version", () => {
    expect(configFor(answers()).split("\n")[0]).toBe(
      `# yaml-language-server: $schema=https://unpkg.com/@turbo-vibe/cli@${major}/schema/turbo-vibe.schema.json`,
    );
  });

  it("labels beta targets in the frontend question", async () => {
    const ask = vi.fn(async (_question: string) => "");
    await run(["init"], {}, {}, undefined, undefined, { ask });
    const questions = ask.mock.calls.map(([question]) => question);
    expect(questions).toContain(
      "Frontend target (cloudflare-static, vercel-static (beta), vercel-nextjs (beta), none)",
    );
  });

  it("names the missing answer when it cannot ask", async () => {
    const { code, stderr } = await run(["init", "--name", "shop"]);
    expect(code).toBe(1);
    expect(stderr).toBe(
      "missing --domain; run init in a terminal to be asked, or pass every option\n",
    );
  });

  it("needs at least a backend or a frontend", async () => {
    const { code, stderr } = await run([
      "init",
      "--name",
      "shop",
      "--domain",
      "shop.example.com",
      "--backend",
      "none",
      "--frontend",
      "none",
      "--database",
      "none",
      "--identity",
      "none",
      "--assistant",
      "none",
    ]);
    expect(code).toBe(1);
    expect(stderr).toBe(
      "init needs a backend or a frontend: --backend and --frontend cannot both be none\n",
    );
  });

  it("writes the chosen assistant guidance, stamped with the CLI's version", async () => {
    const withAssistant = [...flags];
    withAssistant[withAssistant.indexOf("--assistant") + 1] = "both";
    const { code, cwd } = await run(["init", ...withAssistant]);
    expect(code).toBe(0);
    const skill = await readFile(
      join(cwd, ".claude/skills/turbo-vibe/SKILL.md"),
      "utf8",
    );
    const rule = await readFile(
      join(cwd, ".cursor/rules/turbo-vibe.mdc"),
      "utf8",
    );
    const frontMatter = (file: string) => parse(file.split("---\n")[1] ?? "");
    expect(frontMatter(skill)).toEqual({
      name: "turbo-vibe",
      description: expect.stringContaining("turbo-vibe.yaml"),
    });
    expect(frontMatter(rule)).toEqual({
      description: expect.stringContaining("turbo-vibe.yaml"),
      globs: "turbo-vibe.yaml",
      alwaysApply: false,
    });
    for (const file of [skill, rule]) {
      expect(file).toContain(`deployed by turbo-vibe ${version}.`);
      expect(file).toContain("Do not run `promote`");
    }
  });

  it("writes no guidance for none, and leaves existing guidance unchanged", async () => {
    const { cwd } = await run(["init", ...flags]);
    await expect(
      readFile(join(cwd, ".claude/skills/turbo-vibe/SKILL.md"), "utf8"),
    ).rejects.toThrow();
    const withClaude = [...flags];
    withClaude[withClaude.indexOf("--assistant") + 1] = "claude";
    const mine = "my own skill\n";
    const {
      code,
      stderr,
      cwd: existing,
    } = await run(["init", ...withClaude], {
      ".claude/skills/turbo-vibe/SKILL.md": mine,
    });
    expect(code).toBe(1);
    expect(stderr).toBe(
      ".claude/skills/turbo-vibe/SKILL.md already exists; nothing was written (pass --force to replace)\n",
    );
    expect(
      await readFile(
        join(existing, ".claude/skills/turbo-vibe/SKILL.md"),
        "utf8",
      ),
    ).toBe(mine);
  });

  it("writes only the guidance into a project that already has a config", async () => {
    const config = "version: 1\nproject: mine\n";
    const { code, cwd, stdout } = await run(
      ["init", "--only-assistant", "--assistant", "cursor"],
      { "turbo-vibe.yaml": config },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("wrote .cursor/rules/turbo-vibe.mdc\n");
    expect(await readFile(join(cwd, "turbo-vibe.yaml"), "utf8")).toBe(config);
  });

  it("refuses a target it does not know", async () => {
    const { code, stderr } = await run([
      "init",
      ...flags.slice(0, 6),
      "--frontend",
      "netlify",
      "--database",
      "none",
      "--identity",
      "none",
      "--assistant",
      "none",
    ]);
    expect(code).toBe(1);
    expect(stderr).toBe(
      "--frontend must be one of cloudflare-static, vercel-static, vercel-nextjs, none\n",
    );
  });
});
