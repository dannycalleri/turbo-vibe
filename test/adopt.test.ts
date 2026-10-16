import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { adapters } from "../src/adapters/index.js";
import {
  adoptionFiles,
  assistantFiles,
  parseAssistants,
} from "../src/assistant.js";
import { reservedNames } from "../src/config/load.js";
import { backendPort, buildIdVariable, healthPath } from "../src/contract.js";
import { choices } from "../src/init.js";
import { cliRange, version } from "../src/version.js";
import { fakePrompts, run } from "./harness.js";

const skillPath = ".claude/skills/turbo-vibe-adopt/SKILL.md";
const rulePath = ".cursor/rules/turbo-vibe-adopt.mdc";
const frontMatter = (file: string) => parse(file.split("---\n")[1] ?? "");

describe("turbo-vibe adopt", () => {
  it("writes the adoption guidance into a repository without a config, and says what to ask next", async () => {
    const { code, cwd, stdout } = await run(["adopt", "--assistant", "both"]);
    expect(code).toBe(0);
    expect(stdout).toBe(
      `wrote ${skillPath}\nwrote ${rulePath}\nnext: ask your coding assistant to "make this project deployable with turbo-vibe"; it follows the turbo-vibe-adopt guidance\n`,
    );
    const skill = await readFile(join(cwd, skillPath), "utf8");
    const rule = await readFile(join(cwd, rulePath), "utf8");
    expect(frontMatter(skill)).toEqual({
      name: "turbo-vibe-adopt",
      description: expect.stringContaining("existing project"),
    });
    expect(frontMatter(rule)).toEqual({
      description: expect.stringContaining("existing project"),
      alwaysApply: false,
    });
    expect(skill).toContain(`deployable with turbo-vibe ${version}.`);
  });

  it("keeps the guidance out of git in a repository, once, and says so", async () => {
    const first = await run(["adopt", "--assistant", "both"], {
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/info/exclude":
        "# git ls-files --others --exclude-from=.git/info/exclude\n",
    });
    expect(first.stdout).toContain(
      "listed the guidance in .git/info/exclude, so it is never committed\n",
    );
    const again = await run(["adopt", "--assistant", "both", "--force"], {
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/info/exclude": await readFile(
        join(first.cwd, ".git/info/exclude"),
        "utf8",
      ),
    });
    expect(again.stdout).not.toContain(".git/info/exclude");
    expect(await readFile(join(again.cwd, ".git/info/exclude"), "utf8")).toBe(
      `# git ls-files --others --exclude-from=.git/info/exclude\n/${skillPath}\n/${rulePath}\n`,
    );
  });

  it("writes no git exclude outside a repository", async () => {
    const { cwd } = await run(["adopt", "--assistant", "claude"]);
    await expect(
      readFile(join(cwd, ".git/info/exclude"), "utf8"),
    ).rejects.toThrow();
  });

  it("leaves existing guidance unchanged unless forced", async () => {
    const mine = "my own skill\n";
    const { code, cwd, stderr } = await run(
      ["adopt", "--assistant", "claude"],
      { [skillPath]: mine },
    );
    expect(code).toBe(1);
    expect(stderr).toBe(
      `${skillPath} already exists; nothing was written (pass --force to replace)\n`,
    );
    expect(await readFile(join(cwd, skillPath), "utf8")).toBe(mine);
    const forced = await run(["adopt", "--assistant", "claude", "--force"], {
      [skillPath]: mine,
    });
    expect(forced.code).toBe(0);
    expect(await readFile(join(forced.cwd, skillPath), "utf8")).not.toBe(mine);
  });

  it("writes for the assistants the repository already uses, without being told", async () => {
    const { code, stdout } = await run(["adopt"], {
      ".cursor/rules/mine.mdc": "x",
    });
    expect(code).toBe(0);
    expect(stdout).toContain(
      "writing guidance for cursor, found in this repository\n",
    );
    expect(stdout).toContain(`wrote ${rulePath}\n`);
    expect(stdout).not.toContain(skillPath);
  });

  it("asks in a terminal when nothing is found", async () => {
    const { prompts } = fakePrompts({
      "Coding assistants": ["claude", "cursor"],
    });
    const { code, stdout } = await run(
      ["adopt"],
      {},
      {},
      undefined,
      undefined,
      { prompts },
    );
    expect(code).toBe(0);
    expect(stdout).toContain(`wrote ${skillPath}\n`);
    expect(stdout).toContain(`wrote ${rulePath}\n`);
  });

  it("refuses to run with no assistant, and names an unknown one", async () => {
    const message =
      "adopt writes guidance for a coding assistant: pass --assistant claude, cursor, or a list such as claude,cursor\n";
    expect((await run(["adopt"])).stderr).toBe(message);
    expect((await run(["adopt", "--no-assistant"])).stderr).toBe(message);
    const later = await run([
      "adopt",
      "--no-assistant",
      "--assistant",
      "cursor",
    ]);
    expect(later.code).toBe(0);
    expect(later.stdout).toContain(`wrote ${rulePath}\n`);
    const cancelled = await run(["adopt"], {}, {}, undefined, undefined, {
      prompts: fakePrompts({ "Coding assistants": undefined }).prompts,
    });
    expect(cancelled.code).toBe(130);
    expect(cancelled.stderr).toBe("adopt cancelled; nothing was written\n");
    const unknown = await run(["adopt", "--assistant", "claude,codex"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe(
      "--assistant: unknown assistant codex; choose from claude, cursor, as a comma-separated list\n",
    );
  });
});

describe("parseAssistants", () => {
  it("reads comma-separated lists and repeated flags, without duplicates", () => {
    expect(parseAssistants(["cursor, claude", "claude"])).toEqual([
      "cursor",
      "claude",
    ]);
  });

  it("refuses a value that names no assistant, so an empty variable never means none", () => {
    expect(parseAssistants([","])).toBe(
      "no assistant named; choose from claude, cursor, as a comma-separated list",
    );
  });

  it("keeps both and none from before the list", () => {
    expect(parseAssistants(["both"])).toEqual(["claude", "cursor"]);
    expect(parseAssistants(["none"])).toEqual([]);
  });
});

describe("the adoption guidance", () => {
  const guidance = Object.values(adoptionFiles(["claude"], version))[0] ?? "";

  it("lists every target turbo-vibe runs, with an init flag that accepts it", () => {
    const rows = [
      ...guidance.matchAll(/^\| (\w+) \| `([a-z-]+)`.*\| `--(\w+) \2` \|$/gm),
    ];
    expect(rows.map(([, , target]) => target).sort()).toEqual(
      Object.keys(adapters).sort(),
    );
    for (const [, kind, target, flag] of rows) {
      expect(kind).toBe(adapters[target ?? ""]?.kind);
      expect(choices[flag as keyof typeof choices]).toContain(target);
    }
  });

  it("maps the application's own values to the three fields, and names every reserved name the validator refuses", () => {
    for (const field of [
      "the service's `secrets`",
      "the frontend's `public`",
      "the service's `build.secrets`",
    ])
      expect(guidance).toContain(field);
    const { service, credentials } = reservedNames();
    for (const name of [...Object.keys(service), ...Object.keys(credentials)])
      expect(guidance).toContain(`\`${name}\``);
    expect(guidance).not.toContain("secrets of the application's own");
  });

  it("tells an assistant working on the project afterwards where a new value of the application goes", () => {
    const ongoing = Object.values(assistantFiles(["claude"], version))[0] ?? "";
    for (const field of ["`secrets`", "`public`", "`build.secrets`"])
      expect(ongoing).toContain(field);
  });

  it("states the backend contract the deploy checks", () => {
    expect(guidance).toContain(`GET ${healthPath}`);
    expect(guidance).toContain(`on ${backendPort} otherwise`);
    expect(guidance).toContain(`ARG ${buildIdVariable}`);
    expect(guidance).toContain(`ENV ${buildIdVariable}=$${buildIdVariable}`);
  });

  it("runs the CLI at a version npm resolves for this release, as the ongoing guidance does", () => {
    const ongoing = Object.values(assistantFiles(["claude"], version))[0] ?? "";
    const commands = [
      ...`${guidance}${ongoing}`.matchAll(/npx @turbo-vibe\/cli@(\S+)/g),
    ];
    expect(commands.length).toBeGreaterThan(0);
    for (const [, range] of commands) expect(range).toBe(cliRange);
  });
});
