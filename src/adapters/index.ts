import { cloudflareContainer, cloudflareStatic } from "./cloudflare.js";
import type { Adapter } from "./types.js";

export type TargetCatalog = Readonly<
  Record<string, Pick<Adapter, "kind" | "hostsStaticAssets">>
>;

export const adapters: Readonly<Record<string, Adapter>> = {
  [cloudflareContainer.target]: cloudflareContainer,
  [cloudflareStatic.target]: cloudflareStatic,
};

export function adapterFor(target: string): Adapter {
  const adapter = adapters[target];
  if (!adapter) throw new Error(`no adapter for target \`${target}\``);
  return adapter;
}
