import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const json = async (file: string) =>
  JSON.parse(await readFile(join(root, file), "utf8"));

describe("npm-shrinkwrap.json", () => {
  it("is the only lockfile, and it ships with the package", async () => {
    const pkg = await json("package.json");
    expect(pkg.files).toContain("npm-shrinkwrap.json");
    for (const other of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"])
      expect(existsSync(join(root, other)), other).toBe(false);
  });

  it("matches package.json, or `npm install` was not run after a change", async () => {
    const pkg = await json("package.json");
    const shrinkwrap = await json("npm-shrinkwrap.json");
    expect(shrinkwrap.version, "run `npm install`").toBe(pkg.version);
    expect(shrinkwrap.packages[""].dependencies, "run `npm install`").toEqual(
      pkg.dependencies,
    );
    expect(
      shrinkwrap.packages[""].devDependencies,
      "run `npm install`",
    ).toEqual(pkg.devDependencies);
  });

  it("pins every package to a tarball from the npm registry, with its hash", async () => {
    const shrinkwrap = await json("npm-shrinkwrap.json");
    const unpinned = Object.entries(
      shrinkwrap.packages as Record<
        string,
        { resolved?: string; integrity?: string; link?: boolean }
      >,
    )
      .filter(([path, entry]) => path !== "" && !entry.link)
      .filter(
        ([, entry]) =>
          !entry.resolved?.startsWith("https://registry.npmjs.org/") ||
          !entry.integrity?.startsWith("sha512-"),
      )
      .map(([path]) => path);
    expect(unpinned).toEqual([]);
  });
});
