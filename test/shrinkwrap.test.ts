import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const json = async (file: string) =>
  JSON.parse(await readFile(join(root, file), "utf8"));

describe("npm-shrinkwrap.json", () => {
  it("matches package.json, or `make shrinkwrap` was not run after a change", async () => {
    const pkg = await json("package.json");
    const shrinkwrap = await json("npm-shrinkwrap.json");
    expect(shrinkwrap.version, "run `make shrinkwrap`").toBe(pkg.version);
    expect(
      shrinkwrap.packages[""].dependencies,
      "run `make shrinkwrap`",
    ).toEqual(pkg.dependencies);
    expect(pkg.files).toContain("npm-shrinkwrap.json");
  });

  it("ships only package versions that the tests ran against", async () => {
    const shrinkwrap = await json("npm-shrinkwrap.json");
    const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
    const tested = (key: string) =>
      [`\n  ${key}:`, `\n  ${key}(`, `\n  '${key}':`].some((entry) =>
        lockfile.includes(entry),
      );
    const untested = Object.entries(
      shrinkwrap.packages as Record<
        string,
        { name?: string; version: string; dev?: boolean }
      >,
    )
      .filter(([path, entry]) => path !== "" && !entry.dev)
      .map(([path, entry]) => {
        const name =
          entry.name ??
          path.slice(
            path.lastIndexOf("node_modules/") + "node_modules/".length,
          );
        return `${name}@${entry.version}`;
      })
      .filter((key) => !tested(key));
    expect(
      untested,
      "update pnpm-lock.yaml to these versions (pnpm update --depth Infinity <name>), or pin them with an npm override, then run `make shrinkwrap`",
    ).toEqual([]);
  });
});
