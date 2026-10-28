import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

type Entry = { version: string; dev?: boolean; optional?: boolean };

it("installs, with `npm ci` in the unpacked tarball, exactly the tree npm-shrinkwrap.json pins, and runs", async () => {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
  const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-package-"));
  const tarball = execFileSync(
    "npm",
    ["pack", "--pack-destination", dir, "--silent"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  execFileSync("tar", ["xzf", tarball], { cwd: dir });
  const cli = join(dir, "package");
  // As a dependency, npm treats a package's shrinkwrap as advice; as the project's own lockfile, `npm ci` follows it exactly.
  execFileSync(
    "npm",
    ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: cli, stdio: "ignore" },
  );
  const shrinkwrap = JSON.parse(
    await readFile(join(cli, "npm-shrinkwrap.json"), "utf8"),
  );
  const installed = new Map(
    (
      JSON.parse(
        execFileSync("npm", ["query", "*"], { cwd: cli, encoding: "utf8" }),
      ) as { version: string; location: string }[]
    ).map((node) => [node.location, node.version]),
  );
  const differ: string[] = [];
  for (const [location, entry] of Object.entries(
    shrinkwrap.packages as Record<string, Entry>,
  )) {
    if (location === "" || entry.dev) continue;
    const version = installed.get(location);
    if (version === undefined && entry.optional) continue;
    if (version !== entry.version)
      differ.push(`${location}: ${version}, pinned ${entry.version}`);
    installed.delete(location);
  }
  installed.delete("");
  expect(differ, "installed differently from the pin").toEqual([]);
  expect([...installed.keys()], "installed but not pinned").toEqual([]);
  expect(
    execFileSync("node", [join(cli, "dist", "cli.js"), "--version"], {
      encoding: "utf8",
    }).trim(),
  ).toBe(shrinkwrap.version);
}, 600_000);
