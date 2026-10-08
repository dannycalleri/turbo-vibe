import { cloudflareContainer, cloudflareStatic } from "./cloudflare.js";
import { supabase } from "./supabase.js";
import type { Adapter } from "./types.js";
import { workos } from "./workos.js";

export type TargetCatalog = Readonly<
  Record<string, Pick<Adapter, "kind" | "hostsStaticAssets">>
>;

export const adapters: Readonly<Record<string, Adapter>> = {
  [cloudflareContainer.target]: cloudflareContainer,
  [cloudflareStatic.target]: cloudflareStatic,
  [supabase.target]: supabase,
  [workos.target]: workos,
};

export function adapterFor(target: string): Adapter {
  const adapter = adapters[target];
  if (!adapter) throw new Error(`no adapter for target \`${target}\``);
  return adapter;
}
