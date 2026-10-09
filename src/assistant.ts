export const assistants = ["claude", "cursor", "both", "none"] as const;
export type Assistant = (typeof assistants)[number];

const description =
  "Deploying this project with turbo-vibe: editing turbo-vibe.yaml, checking a plan, fixing missing setup, and leaving production promotion to a person.";

const guidance = (version: string) => `# turbo-vibe

This project is deployed by turbo-vibe ${version}. \`turbo-vibe.yaml\` at the repository root describes its services (backend, frontend, database, sign-in) and where each runs. A merge to \`main\` deploys staging; a person promotes the build that passed staging to production.

## Changing what is deployed

- Change infrastructure only by editing \`turbo-vibe.yaml\`. Never create, change or delete vendor resources by hand or with vendor CLIs (\`wrangler deploy\`, \`vercel deploy\`, \`supabase projects create\`): turbo-vibe owns them, and its next run would undo the change.
- The file's first line points at its JSON Schema; every field is described at https://github.com/dannycalleri/turbo-vibe/blob/main/docs/file-format.md.
- After every edit, run \`npx @turbo-vibe/cli@${version.split(".")[0]} plan\`. It validates the file and lists each environment's services and addresses, without credentials.
- When credentials are available, run \`plan --env staging\` before proposing a change and show the person its summary. Point out every line under "Deletions and replacements": those destroy data or traffic.
- Never pass \`--allow-deletions\`, or tick the workflows' allow-deletions input, unless the person has agreed to the specific deletions \`plan\` listed.

## When something is missing

Run \`check --env staging\` (or \`--env production\`). It names each missing account, token, permission or secret with its fix, and changes nothing. Relay the fixes; never invent tokens, and never print or commit a secret value. Secrets belong in the GitHub environments \`staging\` and \`production\`.

## Production is promoted by a person

Do not run \`promote\`, \`apply --env production\` or \`migrate --env production\`, and do not start the "Deploy to production" workflow. Prepare the change and open a pull request. After it merges, staging deploys and its run summary names the build ID; tell the person to run "Deploy to production" with that ID as \`confirm-build\`.

## What the code must keep doing

- A backend answers \`GET /api/health\` with JSON containing \`build_id\`, taken from the \`BUILD_ID\` build argument baked into its image, and listens on port 8080.
- Database changes are new files under \`supabase/migrations/\` in the database service's \`workdir\` (the repository root by default); never edit one that has already been applied. The running app connects with a role that cannot change the schema.
`;

export function assistantFiles(
  choice: Assistant,
  version: string,
): Record<string, string> {
  const files: Record<string, string> = {};
  if (choice === "claude" || choice === "both") {
    files[".claude/skills/turbo-vibe/SKILL.md"] =
      `---\nname: turbo-vibe\ndescription: ${JSON.stringify(description)}\n---\n\n${guidance(version)}`;
  }
  if (choice === "cursor" || choice === "both") {
    files[".cursor/rules/turbo-vibe.mdc"] =
      `---\ndescription: ${JSON.stringify(description)}\nglobs: turbo-vibe.yaml\nalwaysApply: false\n---\n\n${guidance(version)}`;
  }
  return files;
}
