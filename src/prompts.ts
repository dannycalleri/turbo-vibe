import {
  confirm,
  isCancel,
  multiselect,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
import type { Choice, Prompts } from "./io.js";

const clackOptions = <T extends string>(options: readonly Choice<T>[]) =>
  options.map(({ value, label, hint }) => ({
    value,
    label: label ?? value,
    ...(hint ? { hint } : {}),
  }));

export const clackPrompts: Prompts = {
  async text(message, { initial, validate } = {}) {
    const value = await text({
      message,
      ...(initial ? { initialValue: initial } : {}),
      ...(validate ? { validate: (value) => validate(value ?? "") } : {}),
    });
    return isCancel(value) ? undefined : value;
  },
  async select<T extends string>(
    message: string,
    options: readonly Choice<T>[],
    initial?: T,
  ) {
    const value = await select<T>({
      message,
      options: clackOptions(options) as Parameters<
        typeof select<T>
      >[0]["options"],
      ...(initial ? { initialValue: initial } : {}),
    });
    return isCancel(value) ? undefined : value;
  },
  async confirm(message) {
    const value = await confirm({ message });
    return isCancel(value) ? undefined : value;
  },
  spinner(message) {
    const spin = spinner();
    spin.start(message);
    return {
      stop: (message, failed = false) =>
        failed ? spin.error(message) : spin.stop(message),
    };
  },
  async multiselect<T extends string>(
    message: string,
    options: readonly Choice<T>[],
    { initial = [], required }: { initial?: readonly T[]; required: boolean },
  ) {
    const value = await multiselect<T>({
      message,
      options: clackOptions(options) as Parameters<
        typeof multiselect<T>
      >[0]["options"],
      initialValues: [...initial],
      required,
    });
    return isCancel(value) ? undefined : value;
  },
};

export async function askLine(question: string): Promise<string | undefined> {
  const value = await text({ message: question });
  return isCancel(value) ? undefined : (value ?? "");
}

export async function askHidden(question: string): Promise<string | undefined> {
  const value = await password({ message: question, mask: "•" });
  return isCancel(value) ? undefined : (value ?? "");
}
