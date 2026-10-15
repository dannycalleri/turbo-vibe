import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Io } from "../src/io.js";
import { placeholder, withPublicValues } from "../src/secrets.js";

const fakeIo = () =>
  ({ stderr: vi.fn() }) as unknown as Io & {
    stderr: ReturnType<typeof vi.fn>;
  };

async function built(files: Record<string, string | Uint8Array>) {
  const root = await mkdtemp(join(tmpdir(), "turbo-vibe-public-"));
  const dir = join(root, "built");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return { root, dir, copy: join(root, "copy") };
}

describe("withPublicValues", () => {
  const key = placeholder("NEXT_PUBLIC_KEY");

  it("puts each value into every text file of a copy, and leaves the built files with their placeholders", async () => {
    const { dir, copy } = await built({
      "static/chunks/app.js": `const key="${key}";`,
      "index.html": `<meta content="${key}">`,
      "page.rsc": `0:{"key":"${key}"}`,
    });
    const io = fakeIo();
    expect(
      await withPublicValues(dir, copy, { NEXT_PUBLIC_KEY: "pk_live" }, io),
    ).toBe(copy);
    expect(await readFile(join(copy, "static/chunks/app.js"), "utf8")).toBe(
      'const key="pk_live";',
    );
    expect(await readFile(join(copy, "index.html"), "utf8")).toBe(
      '<meta content="pk_live">',
    );
    expect(await readFile(join(copy, "page.rsc"), "utf8")).toBe(
      '0:{"key":"pk_live"}',
    );
    expect(await readFile(join(dir, "index.html"), "utf8")).toContain(key);
  });

  it("inserts a value literally, even one that looks like a replacement pattern", async () => {
    const { dir, copy } = await built({ "app.js": `k="${key}"` });
    const value = "a$$b$`c$&d";
    expect(
      await withPublicValues(dir, copy, { NEXT_PUBLIC_KEY: value }, fakeIo()),
    ).toBe(copy);
    expect(await readFile(join(copy, "app.js"), "utf8")).toBe(`k="${value}"`);
  });

  it("leaves a binary file as it is", async () => {
    const binary = new Uint8Array([0x89, 0x50, 0x00, 0xff, 0x01]);
    const { dir, copy } = await built({ "logo.png": binary });
    expect(
      await withPublicValues(dir, copy, { NEXT_PUBLIC_KEY: "pk" }, fakeIo()),
    ).toBe(copy);
    expect(new Uint8Array(await readFile(join(copy, "logo.png")))).toEqual(
      binary,
    );
  });

  it("stops, naming the file and the name, when a placeholder is left", async () => {
    const { dir, copy } = await built({
      "app.js": `const other="${placeholder("NEXT_PUBLIC_OTHER")}";`,
    });
    const io = fakeIo();
    expect(
      await withPublicValues(dir, copy, { NEXT_PUBLIC_KEY: "pk" }, io),
    ).toBe(1);
    expect(io.stderr).toHaveBeenCalledWith(
      "app.js still holds the placeholder for NEXT_PUBLIC_OTHER after the public values were put in; nothing was shipped\n",
    );
  });
});
