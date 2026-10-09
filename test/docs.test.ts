import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const price = /[$€£]\s?\d|\d\s?(USD|EUR)\b|per (user |seat )?month|\/\s?month/i;
const withoutCode = (markdown: string) =>
  markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/`[^`\n]*`/g, "");

const markdownUnder = async (directory: string): Promise<string[]> =>
  (await readdir(join(root, directory), { recursive: true }))
    .filter((path) => path.endsWith(".md") && !path.includes("node_modules"))
    .map((path) => join(directory, path));

const publicFiles = async () => [
  "README.md",
  ...(await markdownUnder("docs")),
  ...(await markdownUnder("examples")),
  "src/check.ts",
  ...(await readdir(join(root, "src/checks"))).map((file) =>
    join("src/checks", file),
  ),
];

describe("public material", () => {
  it("names plans without stating prices", async () => {
    const offending: string[] = [];
    for (const file of await publicFiles()) {
      const text = await readFile(join(root, file), "utf8");
      const lines = (file.endsWith(".md") ? withoutCode(text) : text).split(
        "\n",
      );
      lines.forEach((line, index) => {
        if (price.test(line)) offending.push(`${file}:${index + 1}: ${line}`);
      });
    }
    expect(offending).toEqual([]);
  });

  it("recognises a price", () => {
    expect(price.test("subscribe to Workers Paid ($5/month)")).toBe(true);
    expect(price.test("Pro is 20 EUR per user per month")).toBe(true);
    expect(price.test('fix: "$20 per seat for a commercial project"')).toBe(
      true,
    );
    expect(price.test("US$5")).toBe(true);
    expect(withoutCode('run `cd "$(dirname "$0")"` first')).not.toMatch(price);
  });
});
