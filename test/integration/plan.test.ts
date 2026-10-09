import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { summarize, type TofuPlan } from "../../src/changes.js";

const pinned = "1.13.1";

function localTofuIsPinned(): boolean {
  try {
    return execFileSync("tofu", ["version"], { encoding: "utf8" }).startsWith(
      `OpenTofu v${pinned}\n`,
    );
  } catch {
    return false;
  }
}

function tofu(dir: string, args: string[]): string {
  if (localTofuIsPinned()) {
    return execFileSync("tofu", args, { cwd: dir, encoding: "utf8" });
  }
  return execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${dir}:${dir}`,
      "-w",
      dir,
      `ghcr.io/opentofu/opentofu:${pinned}`,
      ...args,
    ],
    { encoding: "utf8" },
  );
}

const root = (passwords: Record<string, string>) =>
  JSON.stringify({
    terraform: {
      required_providers: {
        random: { source: "hashicorp/random", version: "3.9.1" },
      },
    },
    resource: {
      random_password: Object.fromEntries(
        Object.entries(passwords).map(([name, keeper]) => [
          name,
          { length: 16, keepers: { keeper } },
        ]),
      ),
    },
  });

describe("the pinned OpenTofu's JSON plan", () => {
  it("summarises into creates, replacements and deletions by address", async () => {
    const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-plan-"));
    await writeFile(join(dir, "main.tf.json"), root({ kept: "1", gone: "1" }));
    tofu(dir, ["init", "-input=false", "-no-color"]);
    tofu(dir, ["apply", "-input=false", "-auto-approve", "-no-color"]);
    await writeFile(join(dir, "main.tf.json"), root({ kept: "2", added: "1" }));
    tofu(dir, ["plan", "-input=false", "-json", "-out=tfplan"]);
    const plan = JSON.parse(tofu(dir, ["show", "-json", "tfplan"])) as TofuPlan;
    const changes = summarize(plan, { exact: new Map(), modules: new Map() });
    expect(
      changes.map(({ address, action }) => `${action} ${address}`).sort(),
    ).toEqual([
      "create random_password.added",
      "delete random_password.gone",
      "replace random_password.kept",
    ]);
  });
});
