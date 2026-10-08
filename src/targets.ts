import type { ServiceKind } from "./config/schema.js";

export interface TargetInfo {
  kind: ServiceKind;
  hostsStaticAssets: boolean;
}

export type TargetCatalog = Readonly<Record<string, TargetInfo>>;

export const targets: TargetCatalog = {
  "cloudflare-container": { kind: "backend", hostsStaticAssets: true },
  "cloudflare-static": { kind: "frontend", hostsStaticAssets: true },
};
