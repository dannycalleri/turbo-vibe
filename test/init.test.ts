import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { parseConfig } from "../src/config/load.js";
import { type Answers, choices, configFor } from "../src/init.js";
import { derivePlan } from "../src/plan.js";
import { setup } from "../src/setup.js";
import { cliRange, version, workflowRef } from "../src/version.js";
import { fakePrompts, run } from "./harness.js";

const setupCode = vi.hoisted(() => ({ value: 0 }));
vi.mock("../src/setup.js", async (original) => ({
  ...(await original<typeof import("../src/setup.js")>()),
  setup: vi.fn(async () => setupCode.value),
}));

const answers = (overrides: Partial<Answers> = {}): Answers => ({
  name: "shop",
  domain: "shop.example.com",
  backend: "cloudflare-container",
  frontend: "cloudflare-static",
  database: "none",
  identity: "none",
  assistant: [],
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

  it("leaves the Supabase organization out, commented, so its slug stays out of the repository", () => {
    const rows = configFor(answers({ database: "supabase" })).split("\n");
    expect(rows).toContain(
      "    # organization: your-org-slug   # or leave it out: setup finds it and stores it as SUPABASE_ORGANIZATION",
    );
    expect(rows.some((row) => /^\s*organization:/.test(row))).toBe(false);
  });

  it("marks every placeholder it fills in", () => {
    const text = configFor(answers({ database: "supabase", lockfile: "npm" }));
    for (const line of [
      "command: npm ci && npm run build",
      "output: dist",
      "region: us-east-1",
    ]) {
      expect(text.split("\n").find((row) => row.includes(line))).toContain("#");
    }
  });

  it.each([
    ["npm", "npm ci && npm run build"],
    [
      "pnpm",
      "corepack enable && pnpm install --frozen-lockfile && pnpm run build",
    ],
    ["yarn", "yarn install --frozen-lockfile && yarn build"],
    ["bun", "npm install && npm run build   # a default: CI has no bun"],
    [
      undefined,
      "npm install && npm run build   # a default: commit a lockfile",
    ],
  ] as const)(
    "builds a static frontend for a %s lockfile",
    (lockfile, command) => {
      const text = configFor(answers({ ...(lockfile ? { lockfile } : {}) }));
      expect(text).toContain(`      command: ${command}`);
    },
  );

  it("installs a Next.js app with its lockfile's tool", () => {
    const text = configFor(
      answers({ frontend: "vercel-nextjs", lockfile: "pnpm" }),
    );
    expect(text).toContain(
      "      command: corepack enable && pnpm install --frozen-lockfile\n",
    );
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
      `uses: dannycalleri/turbo-vibe/.github/workflows/deploy.yml@${workflowRef}\n`,
    );
    expect(
      await readFile(join(cwd, ".github/workflows/production.yml"), "utf8"),
    ).toContain("workflow_dispatch");
  });

  it("reads the lockfile without a terminal too", async () => {
    const { cwd } = await run(
      [
        "init",
        "--name",
        "shop",
        "--domain",
        "shop.example.com",
        "--backend",
        "none",
        "--frontend",
        "cloudflare-static",
        "--database",
        "none",
        "--identity",
        "none",
        "--no-assistant",
      ],
      { "package.json": "{}", "yarn.lock": "" },
    );
    expect(await readFile(join(cwd, "turbo-vibe.yaml"), "utf8")).toContain(
      "command: yarn install --frozen-lockfile && yarn build",
    );
  });

  it("ignores its working folder in git, creating .gitignore when missing", async () => {
    const created = await run(["init", ...flags]);
    expect(await readFile(join(created.cwd, ".gitignore"), "utf8")).toBe(
      ".turbo-vibe/\n",
    );
    expect(created.stdout).toContain(
      "wrote .gitignore, ignoring .turbo-vibe/\n",
    );
    const appended = await run(["init", ...flags], {
      ".gitignore": "node_modules",
    });
    expect(await readFile(join(appended.cwd, ".gitignore"), "utf8")).toBe(
      "node_modules\n.turbo-vibe/\n",
    );
    expect(appended.stdout).toContain("added .turbo-vibe/ to .gitignore\n");
  });

  it("leaves a .gitignore that already ignores its working folder unchanged", async () => {
    const mine = "dist\n/.turbo-vibe\n";
    const { cwd, stdout } = await run(["init", ...flags], {
      ".gitignore": mine,
    });
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe(mine);
    expect(stdout).not.toContain(".gitignore");
  });

  describe("after writing the files", () => {
    const terminal = (now: boolean | undefined, signedIn = true) => {
      const { prompts, asked } = fakePrompts({
        "Set up your accounts now?": now,
      });
      return {
        asked,
        prompts,
        ask: async () => "",
        askSecret: async () => "",
        capture: vi.fn(async (_command: string, args: readonly string[]) =>
          args.join(" ") === "auth status"
            ? { code: signedIn ? 0 : 1, stdout: "" }
            : { code: 1, stdout: "" },
        ),
      };
    };

    const cli = `npx @turbo-vibe/cli@${cliRange}`;
    const steps = (stdout: string) => {
      const list = stdout
        .slice(stdout.indexOf("Next steps:"))
        .trimEnd()
        .split("\n");
      expect(list.join("\n")).not.toContain(" plan");
      return list;
    };
    const push =
      "Commit these files and push to main: every push deploys to staging";
    const live =
      'To go live, approve the "production" job of a passing Staging run';
    const io = (
      now: boolean | undefined,
      signedIn = true,
    ): Parameters<typeof run> => [
      ["init", ...flags],
      {},
      {},
      undefined,
      undefined,
      terminal(now, signedIn),
    ];

    it("runs setup first, then lists only the push and the promotion", async () => {
      setupCode.value = 0;
      vi.mocked(setup).mockClear();
      const { code, stdout } = await run(...io(true));
      expect(code).toBe(0);
      expect(setup).toHaveBeenCalledWith(
        expect.objectContaining({ project: "shop" }),
        { env: ["staging", "production"] },
        expect.objectContaining({ prompts: expect.anything() }),
      );
      const list = steps(stdout);
      expect(list).toHaveLength(3);
      expect(list[1]).toBe(`  1. ${push}`);
      expect(list[2]).toContain(`  2. ${live}`);
    });

    it("starts with fixing what setup reported when setup fails", async () => {
      setupCode.value = 1;
      const { code, stdout } = await run(...io(true));
      expect(code).toBe(1);
      expect(steps(stdout)[1]).toContain(
        `  1. Fix what setup reported above, then run ${cli} setup again`,
      );
      expect(steps(stdout)[2]).toBe(`  2. ${push}`);
    });

    it("prints no steps when the person cancels setup", async () => {
      setupCode.value = 130;
      const { code, stdout } = await run(...io(true));
      expect(code).toBe(130);
      expect(stdout).not.toContain("Next steps:");
    });

    it("starts with setup when the person says no", async () => {
      vi.mocked(setup).mockClear();
      const { code, stdout, stderr } = await run(...io(false));
      expect(code).toBe(0);
      expect(steps(stdout)[1]).toBe(
        `  1. Connect your accounts: ${cli} setup (${cli} setup --list names what you need first: https://github.com/dannycalleri/turbo-vibe/blob/main/docs/bootstrap.md)`,
      );
      expect(steps(stdout)[2]).toBe(`  2. ${push}`);
      expect(stderr).toBe("");
      expect(setup).not.toHaveBeenCalled();
    });

    it("says why it did not offer setup", async () => {
      vi.mocked(setup).mockClear();
      const signedOut = await run(...io(true, false));
      expect(steps(signedOut.stdout)[1]).toContain(
        "it needs a signed-in GitHub CLI, so run gh auth login first",
      );
      const agent = await run(["init", ...flags]);
      expect(steps(agent.stdout)[1]).toMatch(/setup .*, in a terminal$/);
      expect(steps(agent.stdout)).toHaveLength(4);
      expect(setup).not.toHaveBeenCalled();
    });

    it("does not offer setup without a signed-in GitHub CLI, or without a terminal", async () => {
      const signedOut = terminal(true, false);
      for (const io of [signedOut, {}]) {
        const { code, stderr } = await run(
          ["init", ...flags],
          {},
          {},
          undefined,
          undefined,
          io,
        );
        expect(code).toBe(0);
        expect(stderr).toBe("");
      }
      expect(signedOut.asked).toEqual([]);
    });
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

  const replies = {
    "Project name": "shop",
    "Production domain": "shop.example.com",
    Backend: "cloudflare-container",
    Frontend: "vercel-nextjs",
    Database: "none",
    "Sign-in": "none",
    "Coding assistants": [],
  };

  it("asks for what the flags leave out", async () => {
    const { prompts, asked } = fakePrompts(replies);
    const { code, cwd } = await run(["init"], {}, {}, undefined, undefined, {
      prompts,
    });
    expect(code).toBe(0);
    expect(asked).toHaveLength(7);
    expect(await readFile(join(cwd, "turbo-vibe.yaml"), "utf8")).toContain(
      "target: vercel-nextjs",
    );
  });

  it("takes every default from the repository with Enter", async () => {
    const { prompts } = fakePrompts({
      "Project name": "",
      "Production domain": "shop.example.com",
      Backend: "",
      Frontend: "",
      Database: "",
      "Sign-in": "",
      "Coding assistants": [],
    });
    const { code, cwd } = await run(
      ["init"],
      {
        "package.json": JSON.stringify({
          name: "Shop",
          dependencies: { next: "15.0.0" },
        }),
        Dockerfile: "FROM scratch\n",
        "supabase/config.toml": "",
      },
      {},
      undefined,
      undefined,
      { prompts },
    );
    expect(code).toBe(0);
    const config = await readFile(join(cwd, "turbo-vibe.yaml"), "utf8");
    expect(config).toContain("project: shop");
    expect(config).toContain("target: vercel-nextjs");
    expect(config).toContain("target: cloudflare-container");
    expect(config).toContain("target: supabase");
    expect(config).not.toContain("target: workos");
  });

  it("asks again for an invalid name instead of ending the run", async () => {
    const { prompts, asked } = fakePrompts({
      ...replies,
      "Project name": ["My App", "shop"],
    });
    const { code, cwd } = await run(["init"], {}, {}, undefined, undefined, {
      prompts,
    });
    expect(code).toBe(0);
    expect(asked[0]?.problems).toEqual([
      "must be lowercase letters, digits, and hyphens, start with a letter, and be at most 63 characters",
    ]);
    expect(await readFile(join(cwd, "turbo-vibe.yaml"), "utf8")).toContain(
      "project: shop",
    );
  });

  it("writes nothing when the person cancels", async () => {
    const { prompts } = fakePrompts({ ...replies, Frontend: undefined });
    const { code, cwd, stderr } = await run(
      ["init"],
      {},
      {},
      undefined,
      undefined,
      { prompts },
    );
    expect(code).toBe(130);
    expect(stderr).toBe("init cancelled; nothing was written\n");
    await expect(
      readFile(join(cwd, "turbo-vibe.yaml"), "utf8"),
    ).rejects.toThrow();
  });

  it("asks nothing when the flags give every answer", async () => {
    const { prompts, asked } = fakePrompts({});
    const { code } = await run(
      ["init", ...flags],
      {},
      {},
      undefined,
      undefined,
      {
        prompts,
      },
    );
    expect(code).toBe(0);
    expect(asked).toEqual([]);
  });

  it("refuses an unknown target flag before asking anything", async () => {
    const { prompts, asked } = fakePrompts(replies);
    const { code, stderr } = await run(
      ["init", "--backend", "foo"],
      {},
      {},
      undefined,
      undefined,
      { prompts },
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      "--backend must be one of cloudflare-container, none\n",
    );
    expect(asked).toEqual([]);
  });

  it("offers no empty backend when the frontend flag is none", async () => {
    const { prompts, asked } = fakePrompts(replies);
    await run(["init", "--frontend", "none"], {}, {}, undefined, undefined, {
      prompts,
    });
    const backend = asked.find(({ message }) => message === "Backend");
    expect(backend?.options?.map(({ value }) => value)).toEqual([
      "cloudflare-container",
    ]);
  });

  it("describes each target, labels beta ones, and offers no empty frontend without a backend", async () => {
    const { prompts, asked } = fakePrompts({ ...replies, Backend: "none" });
    await run(["init"], {}, {}, undefined, undefined, { prompts });
    const frontend = asked.find(({ message }) => message === "Frontend");
    expect(frontend?.options).toEqual([
      {
        value: "cloudflare-static",
        label: "cloudflare-static",
        hint: "static site on Cloudflare Workers, the successor to Pages",
      },
      {
        value: "vercel-static",
        label: "vercel-static (beta)",
        hint: "static site on Vercel",
      },
      {
        value: "vercel-nextjs",
        label: "vercel-nextjs (beta)",
        hint: "Next.js on Vercel",
      },
    ]);
  });

  it("points the config at the published schema of the running version line", () => {
    expect(configFor(answers()).split("\n")[0]).toBe(
      `# yaml-language-server: $schema=https://unpkg.com/@turbo-vibe/cli@${cliRange}/schema/turbo-vibe.schema.json`,
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
    withAssistant[withAssistant.indexOf("--assistant") + 1] = "claude,cursor";
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

  it("writes guidance for the assistant the repository already uses, and none when it has nothing to go on", async () => {
    const withoutAssistant = flags.filter(
      (_flag, index) =>
        flags[index] !== "--assistant" && flags[index - 1] !== "--assistant",
    );
    const detected = await run(["init", ...withoutAssistant], {
      "CLAUDE.md": "# notes\n",
    });
    expect(detected.code).toBe(0);
    expect(detected.stdout).toContain(
      "writing guidance for claude, found in this repository\n",
    );
    await readFile(
      join(detected.cwd, ".claude/skills/turbo-vibe/SKILL.md"),
      "utf8",
    );
    const bare = await run(["init", ...withoutAssistant]);
    expect(bare.code).toBe(0);
    await expect(
      readFile(join(bare.cwd, ".claude/skills/turbo-vibe/SKILL.md"), "utf8"),
    ).rejects.toThrow();
    const declined = await run(
      ["init", ...withoutAssistant, "--no-assistant"],
      {
        "CLAUDE.md": "# notes\n",
      },
    );
    await expect(
      readFile(
        join(declined.cwd, ".claude/skills/turbo-vibe/SKILL.md"),
        "utf8",
      ),
    ).rejects.toThrow();
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
