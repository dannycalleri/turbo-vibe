import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
    ).toEqual(["promote", "migrate", "apply", "migrate", "promote", "smoke"]);
    const check = steps.findIndex((step: { run?: string }) =>
      step.run?.includes("migrate --env production --check"),
    );
    expect(steps[check].run).toContain('if [[ "$help" == *--check* ]]; then');
    expect(check).toBeGreaterThan(
      steps.findIndex((step: { with?: { ref?: string } }) => step.with?.ref),
    );
    expect(check).toBeLessThan(
      steps.findIndex((step: { run?: string }) =>
        step.run?.includes(" apply --env "),
      ),
    );
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
  it("publishes the release that release-please creates on main, with provenance, and only that job can mint an identity token", async () => {
    const release = await workflow("release.yml");
    expect(release.on.push).toEqual({ branches: ["main"] });
    expect(release.jobs["release-please"].steps[0].with.token).toBe(
      "${{ secrets.RELEASE_PLEASE_TOKEN }}",
    );
    expect(release.jobs.publish.if).toBe(
      "${{ needs.release-please.outputs.created == 'true' }}",
    );
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

  it("moves the major tag only for the newest release in that major, never for a prerelease", async () => {
    const release = await workflow("release.yml");
    expect(release.jobs["major-tag"].if).toBe(
      "${{ !contains(needs.release-please.outputs.tag, '-') }}",
    );
    const move = release.jobs["major-tag"].steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(move.indexOf('[ "$TAG" != "$newest" ]')).toBeLessThan(
      move.indexOf("git push --force"),
    );
    const selection = move.match(/newest=\$\((.*)\)\n/)?.[1];
    expect(selection).toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-tags-"));
    const isolated = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", env: isolated });
    git("init", "-q");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    for (const tag of ["v1.0.0", "v1.0.10", "v1.0.9", "v1.1.0-rc.1"])
      git("tag", tag);
    expect(
      execFileSync("bash", ["-c", `major=v1; ${selection}`], {
        cwd: dir,
        encoding: "utf8",
        env: isolated,
      }).trim(),
    ).toBe("v1.0.10");
  });

  it("publishes only through the protected release environment, from a commit on main, and a prerelease under next", async () => {
    const { publish } = (await workflow("release.yml")).jobs;
    expect(publish.environment).toBe("release");
    const runs: string[] = publish.steps.map(
      (step: { run?: string }) => step.run ?? "",
    );
    const onMain = runs.findIndex((run) =>
      run.includes("git merge-base --is-ancestor HEAD origin/main"),
    );
    const published = runs.findIndex((run) => run.includes("npm publish"));
    expect(onMain).toBeGreaterThanOrEqual(0);
    expect(onMain).toBeLessThan(published);
    expect(runs[published]).toContain(
      "*-*) npm publish --provenance --access public --tag next ;;",
    );
    expect(publish.steps[0].with).toMatchObject({
      ref: "${{ needs.release-please.outputs.tag }}",
      "fetch-depth": 0,
    });
  });

  it("has release-please move every workflow's CLI pin with the package version", async () => {
    const config = JSON.parse(
      await readFile(new URL("release-please-config.json", root), "utf8"),
    );
    const extra: string[] = config.packages["."]["extra-files"].map(
      (file: { path: string }) => file.path,
    );
    for (const name of ["deploy.yml", "promote.yml", "preview.yml"]) {
      expect(extra).toContain(`.github/workflows/${name}`);
      const text = await readFile(
        new URL(`.github/workflows/${name}`, root),
        "utf8",
      );
      // The line edit release-please's generic updater makes on an annotated line.
      const bumped = text
        .split("\n")
        .map((line) =>
          line.includes("x-release-please-version")
            ? line.replace(
                /(\d+)\.(\d+)\.(\d+)(-([\w.]+))?(\+([-\w.]+))?/,
                "1.2.0-rc.3",
              )
            : line,
        )
        .join("\n");
      expect(parse(bumped).env.TURBO_VIBE_CLI).toBe(
        "@turbo-vibe/cli@1.2.0-rc.3",
      );
    }
  });
});

describe("secrets", () => {
  const deploying = [
    ["deploy.yml", "staging"],
    ["promote.yml", "production"],
    ["preview.yml", "deploy"],
    ["preview.yml", "remove"],
  ] as const;
  type Step = { name?: string; env?: Record<string, string>; run?: string };
  const secretsIn = (env?: Record<string, string>) =>
    Object.entries(env ?? {}).filter(([, value]) => value.includes("secrets."));
  const callsCli = (step: Step) => step.run?.includes("turbo-vibe --config");

  it("gives every CLI step every credential an adapter or the state bucket reads", async () => {
    const { adapters } = await import("../src/adapters/index.js");
    const { stateSecrets } = await import("../src/contract.js");
    const names = new Set([
      ...stateSecrets,
      ...Object.values(adapters).flatMap((adapter) => adapter.secrets),
    ]);
    for (const [file, job] of deploying) {
      const definition = await workflow(file);
      const steps: Step[] = definition.jobs[job].steps;
      const cli = steps.filter(callsCli);
      expect(cli.length, `${file} ${job}`).toBeGreaterThan(0);
      for (const name of names) {
        expect(
          definition.on.workflow_call.secrets,
          `${file} accepts ${name}`,
        ).toHaveProperty(name);
        for (const step of cli)
          expect(step.env?.[name], `${file} ${job}: ${step.run}`).toBe(
            `\${{ secrets.${name} }}`,
          );
      }
      const first = JSON.stringify(secretsIn(cli[0]?.env));
      for (const step of cli)
        expect(JSON.stringify(secretsIn(step.env)), step.run).toBe(first);
    }
  });

  it("hands the environment's whole set of secrets only to the steps that apply, deploy, promote or deploy a preview", async () => {
    const delivers =
      /turbo-vibe --config "\$(?:CONFIG|config)" (apply --env|deploy --env staging --build-id "\$BUILD_ID"$|promote --env production --build-id|preview deploy)/m;
    let found = 0;
    let dryRuns = 0;
    for (const file of [
      "deploy.yml",
      "promote.yml",
      "preview.yml",
      "live-run.yml",
    ]) {
      const definition = await workflow(file);
      expect(JSON.stringify(definition.env ?? {})).not.toContain(
        "toJSON(secrets)",
      );
      for (const [name, job] of Object.entries(
        definition.jobs as Record<string, { env?: object; steps?: Step[] }>,
      )) {
        expect(JSON.stringify(job.env ?? {}), `${file} ${name}`).not.toContain(
          "toJSON(secrets)",
        );
        for (const step of job.steps ?? []) {
          const passed = step.env?.TURBO_VIBE_SECRETS;
          if (step.run?.includes("--dry-run")) {
            expect(passed, `${file} ${name}: ${step.run}`).toBe(
              "${{ toJSON(secrets) }}",
            );
            expect(step.env?.TURBO_VIBE_VARS).toBeUndefined();
            dryRuns++;
          } else if (delivers.test(step.run ?? "")) {
            expect(passed, `${file} ${name}: ${step.run}`).toBe(
              "${{ toJSON(secrets) }}",
            );
            expect(
              step.env?.TURBO_VIBE_VARS,
              `${file} ${name}: ${step.run}`,
            ).toBe("${{ toJSON(vars) }}");
            found++;
          } else {
            expect(
              passed,
              `${file} ${name}: ${step.name ?? step.run}`,
            ).toBeUndefined();
            expect(
              step.env?.TURBO_VIBE_VARS,
              `${file} ${name}: ${step.name ?? step.run}`,
            ).toBeUndefined();
          }
        }
      }
    }
    expect(found).toBe(6);
    expect(dryRuns).toBe(1);
  });

  it("gives secrets to no step except those that call the CLI, and never to the job or through $GITHUB_ENV", async () => {
    for (const [file, job] of deploying) {
      const definition = await workflow(file);
      expect(secretsIn(definition.jobs[job].env), `${file} ${job}`).toEqual([]);
      for (const step of definition.jobs[job].steps as Step[]) {
        if (!callsCli(step))
          expect(
            secretsIn(step.env),
            `${file} ${job}: ${step.name ?? step.run}`,
          ).toEqual([]);
        if (/pnpm install|npm ci|npm install/.test(step.run ?? ""))
          expect(secretsIn(step.env), `${file} ${job}: install`).toEqual([]);
      }
    }
    for (const file of ["deploy.yml", "promote.yml", "preview.yml"]) {
      const definition = await workflow(file);
      expect(secretsIn(definition.env), `${file} workflow env`).toEqual([]);
      for (const [name, job] of Object.entries(
        definition.jobs as Record<string, { env?: Record<string, string> }>,
      ))
        expect(secretsIn(job.env), `${file} ${name}`).toEqual([]);
      const text = await readFile(
        new URL(`.github/workflows/${file}`, root),
        "utf8",
      );
      expect(text, file).not.toContain("GITHUB_ENV");
    }
  });

  it("installs the CLI with npm ci in its unpacked package, never with npx", async () => {
    for (const file of ["deploy.yml", "promote.yml", "preview.yml"]) {
      const text = await readFile(
        new URL(`.github/workflows/${file}`, root),
        "utf8",
      );
      expect(text, file).not.toMatch(/exec npx|npx --yes/);
      expect(text, file).toContain(
        "npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
      );
    }
  });

  it("lets the production job receive the builds bucket that promote reads", async () => {
    const promote = await workflow("promote.yml");
    expect(promote.on.workflow_call.secrets).toHaveProperty(
      "TURBO_VIBE_BUILDS_BUCKET",
    );
    for (const step of (promote.jobs.production.steps as Step[]).filter(
      callsCli,
    ))
      expect(step.env?.TURBO_VIBE_BUILDS_BUCKET).toBe(
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
  it("is optional: empty promotes the newest build only where production has a reviewer", async () => {
    const promote = await workflow("promote.yml");
    expect(promote.on.workflow_call.inputs["confirm-build"]).toMatchObject({
      type: "string",
      default: "",
    });
    expect(promote.on.workflow_call.inputs["confirm-build"]).not.toHaveProperty(
      "required",
    );
    const { steps } = promote.jobs.production;
    const choose = steps.find((step: { id?: string }) => step.id === "choose");
    expect(choose.run).toContain(
      'if [ -z "$confirmed" ] && [ "$REVIEWED" = "true" ]; then\n  build_id=$(turbo-vibe --config "$CONFIG" promote --env production --choose)\n',
    );
    expect(choose.run).toContain(
      'promote --env production --choose --confirm "$CONFIRM_BUILD"',
    );
    expect(choose.env.CONFIRM_BUILD).toBe("${{ inputs.confirm-build }}");
    expect(choose.env.REVIEWED).toBe("${{ steps.reviewer.outputs.reviewed }}");
    expect(choose.env.DESCRIBED).toBe("${{ needs.describe.outputs.build-id }}");
    expect(choose.run).toContain('--choose --confirm "$DESCRIBED" --newest');
    expect(promote.jobs.describe.outputs).toEqual({
      "build-id": "${{ steps.describe.outputs.build-id }}",
    });
    const named = steps.find((step: { run?: string }) =>
      step.run?.includes("--choose) || exit 0"),
    );
    expect(named.if).toBe("failure() && steps.choose.outcome == 'failure'");
  });

  it.each([
    ["init's production caller", async () => parse(productionWorkflow)],
    ["the kit's production workflow", () => workflow("production.yml")],
  ])("%s offers it, empty by default, and passes it on", async (_, load) => {
    const caller = await load();
    expect(caller.on.workflow_dispatch.inputs["confirm-build"]).toMatchObject({
      type: "string",
      default: "",
    });
    for (const job of Object.values(caller.jobs) as {
      with?: Record<string, unknown>;
    }[]) {
      expect(job.with?.["confirm-build"]).toBe("${{ inputs.confirm-build }}");
    }
  });
});

describe("the summary before the approval", () => {
  it("comes from a job with no secret and no environment, which the production job waits for", async () => {
    const promote = await workflow("promote.yml");
    const { describe: shown, production } = promote.jobs;
    expect(production.needs).toBe("describe");
    expect(shown.environment).toBeUndefined();
    expect(JSON.stringify(shown)).not.toContain("secrets.");
    const step = shown.steps.at(-1);
    expect(step.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      CONFIRM_BUILD: "${{ inputs.confirm-build }}",
    });
    expect(step.run).toContain(
      'promote --env production --describe ${confirmed:+--build-id "$confirmed"} >> "$GITHUB_STEP_SUMMARY"',
    );
  });
});

describe("init's Staging workflow", () => {
  it("promotes its own build after an approval, only on a push to main with the variable set", () => {
    const { production } = parse(stagingWorkflow).jobs;
    expect(production).toEqual({
      needs: "deploy",
      if: "vars.TURBO_VIBE_PROMOTE_FROM_STAGING == 'true' && github.event_name == 'push' && github.ref == 'refs/heads/main'",
      uses: expect.stringMatching(
        /^dannycalleri\/turbo-vibe\/\.github\/workflows\/promote\.yml@/,
      ),
      with: {
        "confirm-build": "${{ github.sha }}",
        "require-reviewer": true,
        "allow-deletions": "${{ inputs.allow-deletions == true }}",
      },
      secrets: "inherit",
    });
  });
});

describe("the staging run's summary", () => {
  it("points at the run's production job only when the project promotes from staging", async () => {
    const { steps } = (await workflow("deploy.yml")).jobs.staging;
    const named = steps.find(
      (step: { name?: string }) => step.name === "Name the build to promote",
    );
    expect(named.env).toEqual({
      PROMOTE_FROM_STAGING: "${{ vars.TURBO_VIBE_PROMOTE_FROM_STAGING }}",
      EVENT: "${{ github.event_name }}",
    });
    expect(named.run).toContain(
      'if [ "$PROMOTE_FROM_STAGING" = "true" ] && [ "$EVENT" = "push" ]; then',
    );
    expect(named.run).toContain("approve this run's **production** job.");
    expect(named.run).toContain(
      "run **Deploy to production** with confirm-build",
    );
  });
});

describe("require-reviewer", () => {
  it("first checks, without a secret, that production has a required reviewer", async () => {
    const promote = await workflow("promote.yml");
    expect(promote.on.workflow_call.inputs["require-reviewer"]).toMatchObject({
      type: "boolean",
      default: false,
    });
    const { steps } = promote.jobs.production;
    const [check] = steps;
    expect(check.id).toBe("reviewer");
    expect(check.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      REQUIRE_REVIEWER: "${{ inputs.require-reviewer }}",
    });
    expect(check.run).toContain(
      'echo "reviewed=$reviewed" >> "$GITHUB_OUTPUT"',
    );
    expect(check.run).toContain(
      'if [ "$REQUIRE_REVIEWER" = "true" ] && [ "$reviewed" != "true" ]; then',
    );
    expect(check.run).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/environments/production"',
    );
    expect(check.run).toContain('index("required_reviewers") != null');
    const choose = steps.find((step: { id?: string }) => step.id === "choose");
    expect(choose.run).toContain(
      '--confirm "$CONFIRM_BUILD" ${NEWEST:+--newest}',
    );
    expect(choose.env.NEWEST).toBe(
      "${{ inputs.require-reviewer && 'yes' || '' }}",
    );
    expect(check.run).toContain(
      "delete the repository variable TURBO_VIBE_PROMOTE_FROM_STAGING",
    );
    expect(JSON.stringify(check)).not.toContain("secrets.");
  });

  it("names the newer build to approve when a reviewer approved an old run", async () => {
    const { steps } = (await workflow("promote.yml")).jobs.production;
    const named = steps.find((step: { run?: string }) =>
      step.run?.includes("--choose) || exit 0"),
    );
    expect(named.env.REQUIRE_REVIEWER).toBe("${{ inputs.require-reviewer }}");
    expect(named.env.CONFIRM_BUILD).toBe("${{ inputs.confirm-build }}");
    expect(named.env.REVIEWED).toBe("${{ steps.reviewer.outputs.reviewed }}");
    expect(named.env.DESCRIBED).toBe("${{ needs.describe.outputs.build-id }}");
    expect(named.run).toContain(
      "passed staging while this run waited, so the approved build",
    );
    expect(named.run).toContain(
      'elif [ -z "$confirmed" ] && [ "$REVIEWED" = "unknown" ]; then',
    );
    expect(named.run).toContain(
      "confirmed=$(echo \"$CONFIRM_BUILD\" | tr -d '[:space:]')",
    );
    expect(named.run).toContain('if [ "$build_id" = "$confirmed" ]; then');
    expect(named.run).toContain("cannot be promoted; see the log");
    expect(named.run).toContain(
      "Approve the production job of that build's Staging run, or run **Deploy to production**",
    );
  });
});

describe("the live tests workflow", () => {
  it("runs weekly and on demand, from main only, in its own environment", async () => {
    const live = await workflow("live-tests.yml");
    expect(live.on.schedule).toEqual([{ cron: "0 6 * * 1" }]);
    expect(live.on).toHaveProperty("workflow_dispatch");
    const caller = live.jobs.live;
    expect(caller.if).toBe("github.ref == 'refs/heads/main'");
    expect(caller.uses).toBe("./.github/workflows/live-run.yml");
    expect(caller.secrets).toBe("inherit");
    expect(caller.permissions).toBeUndefined();
    const run = await workflow("live-run.yml");
    expect(Object.keys(run.on)).toEqual(["workflow_call"]);
    expect(run.jobs.live.environment).toBe("live");
    expect(run.env.BRANCH).toMatch(/^live run /);
  });

  it("passes the whole set of secrets only from reusable workflows, which GitHub does not hold as malicious", async () => {
    for (const file of await readdir(new URL(".github/workflows/", root))) {
      const text = await readFile(
        new URL(`.github/workflows/${file}`, root),
        "utf8",
      );
      if (!text.includes("toJSON(secrets)")) continue;
      expect(Object.keys((await workflow(file)).on), file).toEqual([
        "workflow_call",
      ]);
    }
  });

  describe("proposes COMPATIBILITY.md alone, in a pull request that merges itself", () => {
    async function proposeStep(): Promise<{
      run: string;
      env: Record<string, string>;
    }> {
      const { steps } = (await workflow("live-run.yml")).jobs.live;
      return steps.find(
        (step: { name?: string }) =>
          step.name === "Propose COMPATIBILITY.md when it changed",
      );
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
      // A stand-in for gh: it logs each call, and lists the branches in OPEN as open pull requests.
      const bin = join(dir, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "gh"),
        '#!/bin/sh\necho "$*" >> "$GH_LOG"\n[ "$1 $2" = "pr list" ] && printf "%s" "$OPEN"\nexit 0\n',
        { mode: 0o755 },
      );
      const log = join(dir, "gh.log");
      const run = (open = "") =>
        execFileSync("bash", ["-e", "-c", step.run], {
          cwd: work,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GH_LOG: log,
            OPEN: open,
            RESULTS: "live-results/7",
            GITHUB_RUN_NUMBER: "7",
            GITHUB_RUN_ID: "123",
            GITHUB_SERVER_URL: "https://github.com",
            GITHUB_REPOSITORY: "acme/kit",
          },
        });
      const calls = async () =>
        (await readFile(log, "utf8").catch(() => "")).trim().split("\n");
      const step = await proposeStep();
      return { git, origin, work, run, calls };
    }

    it("pushes only the results to their own branch, and leaves main to the pull request", async () => {
      const { git, origin, work, run, calls } = await repository();
      await writeFile(join(work, "COMPATIBILITY.md"), "new\n");
      await writeFile(join(work, "built.txt"), "changed by a build\n");
      run();
      expect(git(origin, "show", "live-results/7:COMPATIBILITY.md")).toBe(
        "new",
      );
      expect(git(origin, "show", "live-results/7:built.txt")).toBe("clean");
      expect(git(origin, "show", "main:COMPATIBILITY.md")).toBe("old");
      const made = await calls();
      expect(made).toContain("auth setup-git");
      expect(
        made.some((call) =>
          call.startsWith("pr create --base main --head live-results/7 "),
        ),
      ).toBe(true);
      expect(made.at(-1)).toBe(
        "pr merge live-results/7 --auto --rebase --delete-branch",
      );
    });

    it("closes last week's results pull request when it is still open", async () => {
      const { work, run, calls } = await repository();
      await writeFile(join(work, "COMPATIBILITY.md"), "new\n");
      run("live-results/6\n");
      expect(await calls()).toContain(
        "pr close live-results/6 --delete-branch --comment Superseded by live-results/7.",
      );
    });

    it("does nothing when the results did not change", async () => {
      const { git, origin, run, calls } = await repository();
      run();
      expect(git(origin, "branch", "--list", "live-results/*")).toBe("");
      expect(await calls()).toEqual([""]);
    });

    it("pushes with the results token, and keeps no credentials in the checkout", async () => {
      const { env } = await proposeStep();
      expect(env.GH_TOKEN).toBe("${{ secrets.LIVE_RESULTS_TOKEN }}");
      const { jobs } = await workflow("live-run.yml");
      expect(jobs.live.permissions).toBeUndefined();
      expect(jobs.live.steps[0].with["persist-credentials"]).toBe(false);
    });
  });

  it("removes every preview it deploys, whatever the deploy's outcome", async () => {
    const { steps } = (await workflow("live-run.yml")).jobs.live;
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
