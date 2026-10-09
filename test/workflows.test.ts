import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { productionWorkflow, stagingWorkflow } from "../src/init.js";

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

  it("deploys only from main, on a push or a manual run, one run per environment at a time", async () => {
    const { staging } = (await workflow("deploy.yml")).jobs;
    expect(staging.if).toBe(
      "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    );
    expect(staging.environment).toBe("staging");
    expect(staging.concurrency["cancel-in-progress"]).toBe(false);
  });
});

describe("the staging job", () => {
  it("migrates after apply and before deploy, so a failed migration ships nothing", async () => {
    const { steps } = (await workflow("deploy.yml")).jobs.staging;
    const commands = steps
      .map(
        (step: { run?: string }) =>
          step.run?.match(/turbo-vibe .* (\w+) --env/)?.[1],
      )
      .filter(Boolean);
    expect(commands).toEqual(["apply", "migrate", "deploy", "smoke"]);
  });
});

describe("the production workflow", () => {
  const commands = (steps: { run?: string }[]) =>
    steps
      .map(
        (step) => step.run?.match(/turbo-vibe --config "\$CONFIG" (\w+)/)?.[1],
      )
      .filter(Boolean);

  it("runs only when a maintainer starts it", async () => {
    expect(Object.keys((await workflow("production.yml")).on)).toEqual([
      "workflow_dispatch",
    ]);
  });

  it("waits for the production environment's approval and runs one promotion at a time", async () => {
    const { production } = (await workflow("promote.yml")).jobs;
    expect(production.environment).toBe("production");
    expect(production.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("migrates and deploys the build it chose, from that build's commit, without building anything", async () => {
    const { steps } = (await workflow("promote.yml")).jobs.production;
    expect(
      commands(
        steps.filter(
          (step: { if?: string }) => !step.if?.includes("failure()"),
        ),
      ),
    ).toEqual(["promote", "apply", "migrate", "promote", "smoke"]);
    const checkout = steps.findIndex(
      (step: { with?: { ref?: string } }) => step.with?.ref,
    );
    expect(steps[checkout].with.ref).toBe(
      "${{ steps.choose.outputs.build-id }}",
    );
    expect(checkout).toBeGreaterThan(
      steps.findIndex((step: { id?: string }) => step.id === "choose"),
    );
    expect(
      steps.map((step: { run?: string }) => step.run ?? "").join("\n"),
    ).not.toMatch(/\bdeploy --env|docker build/);
  });

  it("promotes and smoke-checks the very build it chose and checked out", async () => {
    const { steps } = (await workflow("promote.yml")).jobs.production;
    const pinned = steps.filter((step: { run?: string }) =>
      step.run?.includes("--build-id"),
    );
    expect(pinned).toHaveLength(2);
    for (const step of pinned) {
      expect(step.env.BUILD_ID).toBe("${{ steps.choose.outputs.build-id }}");
    }
    const checkout = steps.findIndex(
      (step: { with?: { ref?: string } }) => step.with?.ref,
    );
    const rebuild = steps.findIndex((step: { name?: string }) =>
      step.name?.startsWith("Rebuild the CLI"),
    );
    expect(rebuild).toBeGreaterThan(checkout);
  });

  it("runs the same CLI release as the staging workflow", async () => {
    expect((await workflow("promote.yml")).env.TURBO_VIBE_CLI).toBe(
      (await workflow("deploy.yml")).env.TURBO_VIBE_CLI,
    );
  });
});

describe("the release workflow", () => {
  it("publishes from a version tag with provenance, and only that job can mint an identity token", async () => {
    const release = await workflow("release.yml");
    expect(release.on.push.tags).toEqual(["v*.*.*"]);
    expect(release.permissions).toEqual({ contents: "read" });
    expect(release.jobs.publish.permissions["id-token"]).toBe("write");
    expect(release.jobs["major-tag"].permissions).toEqual({
      contents: "write",
    });
    const runs = release.jobs.publish.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(runs).toContain("npm publish --provenance --access public");
    expect(runs).toMatch(/test "\$TAG" = "v\$version"/);
  });

  it("moves the major tag only for the newest release in that major", async () => {
    const release = await workflow("release.yml");
    const move = release.jobs["major-tag"].steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(move).toContain('git tag --list "$major.*.*" --sort=-v:refname');
    expect(move.indexOf('[ "$TAG" != "$newest" ]')).toBeLessThan(
      move.indexOf("git push --force"),
    );
  });
});

describe("secrets", () => {
  it("lets every reusable workflow job that deploys receive every credential an adapter or the state bucket reads", async () => {
    const { adapters } = await import("../src/adapters/index.js");
    const { stateSecrets } = await import("../src/infrastructure.js");
    const names = new Set([
      ...stateSecrets,
      ...Object.values(adapters).flatMap((adapter) => adapter.secrets),
    ]);
    for (const [file, job] of [
      ["deploy.yml", "staging"],
      ["promote.yml", "production"],
      ["preview.yml", "deploy"],
      ["preview.yml", "remove"],
    ] as const) {
      const definition = await workflow(file);
      for (const name of names) {
        expect(
          definition.on.workflow_call.secrets,
          `${file} accepts ${name}`,
        ).toHaveProperty(name);
        expect(definition.jobs[job].env[name], `${file} passes ${name}`).toBe(
          `\${{ secrets.${name} }}`,
        );
      }
    }
  });
});

describe("the preview workflow", () => {
  const sameRepository =
    "github.event.pull_request.head.repo.full_name == github.repository";

  it("gives a fork's pull request no preview, says why, and touches no secret", async () => {
    const { fork } = (await workflow("preview.yml")).jobs;
    expect(fork.if).toBe(
      "github.event.pull_request.head.repo.full_name != github.repository",
    );
    expect(fork.steps[0].run).toContain(
      "Previews are only created for pull requests from branches of this repository",
    );
    expect(JSON.stringify(fork)).not.toContain("${{ secrets.");
    expect(fork).not.toHaveProperty("environment");
  });

  it("deploys a branch's preview while the pull request is open, and removes it when it closes", async () => {
    const { deploy, remove } = (await workflow("preview.yml")).jobs;
    expect(deploy.if).toBe(
      `${sameRepository} && github.event.action != 'closed'`,
    );
    expect(remove.if).toBe(
      `${sameRepository} && github.event.action == 'closed'`,
    );
    const runs = (job: { steps: { run?: string }[] }) =>
      job.steps.map((step) => step.run ?? "").join("\n");
    expect(runs(deploy)).toContain(
      'preview deploy --branch "$BRANCH" --build-id "$BUILD_ID"',
    );
    expect(runs(deploy)).toContain(
      'marker="<!-- turbo-vibe-preview:$CONFIG -->"',
    );
    expect(runs(deploy)).toContain("select(.body | startswith(env.MARKER))");
    expect(runs(deploy)).toContain("grep -E '^(preview|no preview):'");
    expect(runs(deploy)).not.toContain("--edit-last");
    expect(deploy.concurrency["cancel-in-progress"]).toBe(false);
    expect(runs(remove)).toContain('preview remove --branch "$BRANCH"');
    expect(deploy.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    });
  });

  it("runs the same CLI release as the other reusable workflows", async () => {
    expect((await workflow("preview.yml")).env.TURBO_VIBE_CLI).toBe(
      (await workflow("deploy.yml")).env.TURBO_VIBE_CLI,
    );
  });

  it("is called by the kit for the examples without a database, on every pull request event that matters", async () => {
    const previews = await workflow("previews.yml");
    expect(previews.on.pull_request.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "closed",
    ]);
    expect(
      Object.values(previews.jobs).map(
        (job) => (job as { with: { config: string } }).with.config,
      ),
    ).toEqual([
      "examples/python-api/turbo-vibe.yaml",
      "examples/vercel-static/turbo-vibe.yaml",
    ]);
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

describe("allow-deletions", () => {
  const passThrough = "${{ inputs.allow-deletions == true }}";

  it.each([
    ["deploy.yml", "staging"],
    ["promote.yml", "production"],
  ])(
    "%s takes it, off by default, and hands it to apply",
    async (name, job) => {
      const reusable = await workflow(name);
      expect(reusable.on.workflow_call.inputs["allow-deletions"]).toEqual({
        description: expect.any(String),
        type: "boolean",
        default: false,
      });
      const step = reusable.jobs[job].steps.find(
        (candidate: { run?: string }) =>
          candidate.run?.includes(" apply --env "),
      );
      expect(step.run).toMatch(/ \$\{ALLOW_DELETIONS:\+--allow-deletions\}$/);
      expect(step.env.ALLOW_DELETIONS).toBe(
        "${{ inputs.allow-deletions && 'yes' || '' }}",
      );
    },
  );

  it.each([
    ["init's staging caller", async () => parse(stagingWorkflow)],
    ["init's production caller", async () => parse(productionWorkflow)],
    ["the kit's pipeline", () => workflow("pipeline.yml")],
    ["the kit's production workflow", () => workflow("production.yml")],
  ])("%s asks for it on a manual run and passes it on", async (_, load) => {
    const caller = await load();
    expect(caller.on.workflow_dispatch.inputs["allow-deletions"]).toMatchObject(
      {
        type: "boolean",
        default: false,
      },
    );
    const jobs = Object.values(caller.jobs) as {
      uses?: string;
      with?: Record<string, unknown>;
    }[];
    const callers = jobs.filter((job) =>
      /(deploy|promote)\.yml/.test(job.uses ?? ""),
    );
    expect(callers.length).toBeGreaterThan(0);
    for (const job of callers) {
      expect(job.with?.["allow-deletions"]).toBe(passThrough);
    }
  });
});

describe("confirm-build", () => {
  it("is required, and the choice refuses any other build", async () => {
    const promote = await workflow("promote.yml");
    expect(promote.on.workflow_call.inputs["confirm-build"]).toMatchObject({
      type: "string",
      required: true,
    });
    const { steps } = promote.jobs.production;
    const choose = steps.find((step: { id?: string }) => step.id === "choose");
    expect(choose.run).toContain(
      'promote --env production --choose --confirm "$CONFIRM_BUILD"',
    );
    expect(choose.env.CONFIRM_BUILD).toBe("${{ inputs.confirm-build }}");
    const named = steps.find((step: { run?: string }) =>
      step.run?.includes("GITHUB_STEP_SUMMARY"),
    );
    expect(named.if).toBe("failure() && steps.choose.outcome == 'failure'");
  });

  it.each([
    ["init's production caller", async () => parse(productionWorkflow)],
    ["the kit's production workflow", () => workflow("production.yml")],
  ])("%s asks for it and passes it on", async (_, load) => {
    const caller = await load();
    expect(caller.on.workflow_dispatch.inputs["confirm-build"]).toMatchObject({
      type: "string",
      required: true,
    });
    for (const job of Object.values(caller.jobs) as {
      with?: Record<string, unknown>;
    }[]) {
      expect(job.with?.["confirm-build"]).toBe("${{ inputs.confirm-build }}");
    }
  });
});

describe("the evidence workflow", () => {
  it("runs weekly and on demand, from main only, in its own environment", async () => {
    const evidence = await workflow("evidence.yml");
    expect(evidence.on.schedule).toEqual([{ cron: "0 6 * * 1" }]);
    expect(evidence.on).toHaveProperty("workflow_dispatch");
    const job = evidence.jobs.evidence;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("evidence");
    expect(evidence.env.BRANCH).toMatch(/^evidence-/);
  });

  it("removes every preview it deploys, whatever the deploy's outcome", async () => {
    const { steps } = (await workflow("evidence.yml")).jobs.evidence;
    const loop = steps.find((step: { run?: string }) =>
      step.run?.includes("preview deploy"),
    ).run as string;
    const examples = loop
      .match(/for example in ([\w -]+); do/)?.[1]
      ?.split(" ");
    const previewable: string[] = [];
    for (const entry of await readdir(new URL("examples/", root), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const config = parse(
        await readFile(
          new URL(`examples/${entry.name}/turbo-vibe.yaml`, root),
          "utf8",
        ),
      );
      if (config.previews) previewable.push(entry.name);
    }
    expect(examples?.sort()).toEqual(previewable.sort());
    expect(loop).toMatch(
      /\n\s+fi\n\s+turbo-vibe --config "\$config" preview remove --branch "\$BRANCH" \|\| removal=failed\n/,
    );
  });
});
