import { createRequire } from "node:module";

export const { version } = createRequire(import.meta.url)(
  "../package.json",
) as {
  version: string;
};
export const major = version.split(".")[0] ?? "1";
