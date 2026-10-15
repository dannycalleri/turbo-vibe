import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { adapters } from "../src/adapters/index.js";
import { adoptionFiles, assistantFiles } from "../src/assistant.js";
import { backendPort, buildIdVariable, healthPath } from "../src/contract.js";
import { choices } from "../src/init.js";
import { cliRange, version } from "../src/version.js";
import { run } from "./harness.js";

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

  it("asks which assistant in a terminal, and refuses without one or with an unknown one", async () => {
    const ask = vi.fn(async () => "cursor");
    const asked = await run(["adopt"], {}, {}, undefined, undefined, { ask });
    expect(asked.code).toBe(0);
    expect(asked.stdout).toContain(`wrote ${rulePath}\n`);

    const missing = await run(["adopt"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe(
      "missing --assistant; pass claude, cursor, both, or run adopt in a terminal to be asked\n",
    );

    const unknown = await run(["adopt", "--assistant", "none"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe(
      "--assistant must be one of claude, cursor, both\n",
    );
  });
});

describe("the adoption guidance", () => {
  const guidance = Object.values(adoptionFiles("claude", version))[0] ?? "";

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

  it("states the backend contract the deploy checks", () => {
    expect(guidance).toContain(`GET ${healthPath}`);
    expect(guidance).toContain(`on ${backendPort} otherwise`);
    expect(guidance).toContain(`ARG ${buildIdVariable}`);
    expect(guidance).toContain(`ENV ${buildIdVariable}=$${buildIdVariable}`);
  });

  it("runs the CLI at a version npm resolves for this release, as the ongoing guidance does", () => {
    const ongoing = Object.values(assistantFiles("claude", version))[0] ?? "";
    const commands = [
      ...`${guidance}${ongoing}`.matchAll(/npx @turbo-vibe\/cli@(\S+)/g),
    ];
    expect(commands.length).toBeGreaterThan(0);
    for (const [, range] of commands) expect(range).toBe(cliRange);
  });
});
