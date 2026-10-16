import { cloudflareContainer, cloudflareStatic } from "./cloudflare.js";
import { supabase } from "./supabase.js";
import type { Adapter } from "./types.js";
import { vercelNextjs, vercelStatic } from "./vercel.js";
import { workos } from "./workos.js";

export type TargetCatalog = Readonly<
  Record<
    string,
    Pick<Adapter, "kind" | "hostsStaticAssets" | "buildsOwnOutput"> &
      Partial<Pick<Adapter, "secrets" | "runsServerCode" | "crossOrigin">>
  >
>;

export const adapters: Readonly<Record<string, Adapter>> = {
  [cloudflareContainer.target]: cloudflareContainer,
  [cloudflareStatic.target]: cloudflareStatic,
  [supabase.target]: supabase,
  [workos.target]: workos,
  [vercelStatic.target]: vercelStatic,
  [vercelNextjs.target]: vercelNextjs,
};

export function adapterFor(target: string): Adapter {
  const adapter = adapters[target];
  if (!adapter) throw new Error(`no adapter for target \`${target}\``);
  return adapter;
}
