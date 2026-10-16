import type { Io } from "../io.js";

export type Checked<T> = { value: T; found: string } | { problem: string };

export async function checked<T>(
  io: Io,
  message: string,
  work: () => Promise<Checked<T>>,
): Promise<Checked<T>> {
  const spinner = io.prompts?.spinner(message);
  const result: Checked<T> = await work().catch((error: unknown) => ({
    problem: `could not check it (${error instanceof Error ? error.message : String(error)}); check the connection and paste it again`,
  }));
  if ("found" in result) {
    if (spinner) spinner.stop(result.found);
    else io.stdout(`${result.found}\n`);
  } else if (spinner) spinner.stop(result.problem, true);
  else io.stderr(`${result.problem}\n`);
  return result;
}
