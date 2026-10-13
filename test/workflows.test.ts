import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("promotes the chosen example, or every example by default", async () => {
    const { on, jobs } = await workflow("production.yml");
    const { example } = on.workflow_dispatch.inputs;
    expect(example.default).toBe("all");
    expect(example.options).toEqual(["all", ...Object.keys(jobs)]);
    for (const job of Object.keys(jobs)) {
      expect(jobs[job].if).toBe(
        `inputs.example == 'all' || inputs.example == '${job}'`,
      );
    }
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

  it("lets the production job receive the builds bucket that promote reads", async () => {
    const promote = await workflow("promote.yml");
    expect(promote.on.workflow_call.secrets).toHaveProperty(
      "TURBO_VIBE_BUILDS_BUCKET",
    );
    expect(promote.jobs.production.env.TURBO_VIBE_BUILDS_BUCKET).toBe(
      "${{ secrets.TURBO_VIBE_BUILDS_BUCKET }}",
    );
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

  it("checks out the commit the preview reports as its build", async () => {
    const preview = await workflow("preview.yml");
    for (const job of ["deploy", "remove"]) {
      const checkout = preview.jobs[job].steps.find((step: { uses?: string }) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkout.with.ref, job).toBe(preview.env.BUILD_ID);
    }
    expect(preview.env.BUILD_ID).toBe(
      "${{ github.event.pull_request.head.sha }}",
    );
  });

  it("runs every preview job that holds secrets in the preview environment, never in staging or production", async () => {
    const { jobs } = await workflow("preview.yml");
    const withSecrets = Object.entries(jobs).filter(
      ([, job]) => (job as { environment?: string }).environment !== undefined,
    );
    expect(withSecrets.map(([name]) => name).sort()).toEqual([
      "deploy",
      "remove",
    ]);
    for (const [, job] of withSecrets)
      expect((job as { environment: string }).environment).toBe("preview");
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

describe("the live tests workflow", () => {
  it("runs weekly and on demand, from main only, in its own environment", async () => {
    const live = await workflow("live-tests.yml");
    expect(live.on.schedule).toEqual([{ cron: "0 6 * * 1" }]);
    expect(live.on).toHaveProperty("workflow_dispatch");
    const job = live.jobs.live;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("live");
    expect(live.env.BRANCH).toMatch(/^live-/);
  });

  describe("commits COMPATIBILITY.md alone", () => {
    async function commitStep(): Promise<string> {
      const { steps } = (await workflow("live-tests.yml")).jobs.live;
      return steps.find(
        (step: { name?: string }) =>
          step.name === "Commit COMPATIBILITY.md when it changed",
      ).run;
    }

    async function repository() {
      const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-live-"));
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      const origin = join(dir, "origin.git");
      const work = join(dir, "work");
      git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
      git(dir, "clone", "--quiet", origin, work);
      git(work, "config", "user.name", "test");
      git(work, "config", "user.email", "test@example.com");
      await writeFile(join(work, "COMPATIBILITY.md"), "old\n");
      await writeFile(join(work, "built.txt"), "clean\n");
      git(work, "add", ".");
      git(work, "commit", "--quiet", "-m", "start");
      git(work, "push", "--quiet", "origin", "HEAD:main");
      return { git, origin, work };
    }

    const run = (script: string, cwd: string) =>
      execFileSync("bash", ["-e", "-c", script], { cwd, encoding: "utf8" });

    it("pushes the new results while a build has left another tracked file changed", async () => {
      const { git, origin, work } = await repository();
      await writeFile(join(work, "COMPATIBILITY.md"), "new\n");
      await writeFile(join(work, "built.txt"), "changed by a build\n");
      run(await commitStep(), work);
      expect(git(origin, "show", "main:COMPATIBILITY.md")).toBe("new");
      expect(git(origin, "show", "main:built.txt")).toBe("clean");
    });

    it("warns and pushes nothing when main changed COMPATIBILITY.md during the run", async () => {
      const { git, origin, work } = await repository();
      const other = join(work, "..", "other");
      git(work, "clone", "--quiet", origin, other);
      git(other, "config", "user.name", "test");
      git(other, "config", "user.email", "test@example.com");
      await writeFile(join(other, "COMPATIBILITY.md"), "from main\n");
      git(other, "commit", "--quiet", "-am", "meanwhile");
      git(other, "push", "--quiet", "origin", "HEAD:main");
      await writeFile(join(work, "COMPATIBILITY.md"), "new\n");
      expect(run(await commitStep(), work)).toContain(
        "::warning::main changed COMPATIBILITY.md during the run",
      );
      expect(git(origin, "show", "main:COMPATIBILITY.md")).toBe("from main");
    });
  });

  it("removes every preview it deploys, whatever the deploy's outcome", async () => {
    const { steps } = (await workflow("live-tests.yml")).jobs.live;
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
