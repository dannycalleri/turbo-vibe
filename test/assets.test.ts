import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addAnalytics,
  analyticsBeacon,
  keepFromSearchEngines,
} from "../src/adapters/assets.js";

async function site(files: Record<string, string | Uint8Array>) {
  const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-assets-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

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

describe("addAnalytics", () => {
  const beacon = analyticsBeacon("tok123");
  const read = (dir: string, name: string) => readFile(join(dir, name), "utf8");

  it("inserts the beacon right before the last </body>, even after characters that lengthen in lower case", async () => {
    const dir = await site({ "index.html": "<body>İİ</body>" });
    await addAnalytics(dir, "tok123");
    expect(await read(dir, "index.html")).toBe(`<body>İİ${beacon}</body>`);
  });

  it("matches the closing tag in any letter case, and the page extension in any letter case", async () => {
    const dir = await site({
      "a/index.HTM": "<BODY>x</BODY >",
      "b.html": "<body><pre></body></pre></body>",
    });
    await addAnalytics(dir, "tok123");
    expect(await read(dir, "a/index.HTM")).toBe(`<BODY>x${beacon}</BODY >`);
    expect(await read(dir, "b.html")).toBe(
      `<body><pre></body></pre>${beacon}</body>`,
    );
  });

  it("leaves a file without </body> as it is", async () => {
    const dir = await site({
      "google1234abcd.html": "google-site-verification",
    });
    await addAnalytics(dir, "tok123");
    expect(await read(dir, "google1234abcd.html")).toBe(
      "google-site-verification",
    );
  });

  it("leaves a page that is not UTF-8 byte for byte as it is", async () => {
    const latin1 = new Uint8Array([
      ...new TextEncoder().encode("<body>caf"),
      0xe9,
      ...new TextEncoder().encode("</body>"),
    ]);
    const dir = await site({ "fr.html": latin1 });
    await addAnalytics(dir, "tok123");
    expect(new Uint8Array(await readFile(join(dir, "fr.html")))).toEqual(
      latin1,
    );
  });

  it("adds no second beacon on a second run, or to a page that already loads one", async () => {
    const own =
      '<body><script src="https://static.cloudflareinsights.com/beacon.min.js"></script></body>';
    const dir = await site({ "index.html": "<body></body>", "own.html": own });
    await addAnalytics(dir, "tok123");
    await addAnalytics(dir, "other");
    expect(await read(dir, "index.html")).toBe(`<body>${beacon}</body>`);
    expect(await read(dir, "own.html")).toBe(own);
  });
});
