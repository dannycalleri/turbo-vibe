import { createRequire } from "node:module";

export const { version } = createRequire(import.meta.url)(
  "../package.json",
) as {
  version: string;
};
export const major = version.split(".")[0] ?? "1";

// A major-only range never matches a prerelease on npm, and a prerelease never moves the major tag.
export function references(of: string): {
  cliRange: string;
  workflowRef: string;
} {
  const first = of.split(".")[0] ?? "1";
  return of.includes("-")
    ? { cliRange: of, workflowRef: `v${of}` }
    : { cliRange: first, workflowRef: `v${first}` };
}

export const { cliRange, workflowRef } = references(version);
