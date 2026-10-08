import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);

async function workflow(name: string) {
  return parse(
    await readFile(new URL(`.github/workflows/${name}`, root), "utf8"),
  );
}

describe("the reusable workflow", () => {
  it("runs the CLI release that matches this package", async () => {
    const { version } = JSON.parse(
      await readFile(new URL("package.json", root), "utf8"),
    );
    expect((await workflow("deploy.yml")).env.TURBO_VIBE_CLI).toBe(
      `@turbo-vibe/cli@${version}`,
    );
  });

  it("deploys only on pushes to main, one run per environment at a time", async () => {
    const { staging } = (await workflow("deploy.yml")).jobs;
    expect(staging.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(staging.environment).toBe("staging");
    expect(staging.concurrency["cancel-in-progress"]).toBe(false);
  });
});

describe("workflows", () => {
  it("never run pull-request code with secrets through pull_request_target", async () => {
    const dir = new URL(".github/workflows/", root);
    for (const file of await readdir(dir)) {
      expect(await readFile(new URL(file, dir), "utf8")).not.toContain(
        "pull_request_target",
      );
    }
  });
});
