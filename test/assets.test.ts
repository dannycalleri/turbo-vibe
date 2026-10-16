import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keepFromSearchEngines } from "../src/adapters/assets.js";

describe("keepFromSearchEngines", () => {
  it("writes a _headers file when the build has none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-assets-"));
    await keepFromSearchEngines(dir);
    expect(await readFile(join(dir, "_headers"), "utf8")).toBe(
      "/*\n  X-Robots-Tag: noindex\n",
    );
  });

  it("appends to the build's own rules, on a new line when its last one has no newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-assets-"));
    await writeFile(join(dir, "_headers"), "/a/*\n  Cache-Control: immutable");
    await keepFromSearchEngines(dir);
    expect(await readFile(join(dir, "_headers"), "utf8")).toBe(
      "/a/*\n  Cache-Control: immutable\n/*\n  X-Robots-Tag: noindex\n",
    );
  });
});
