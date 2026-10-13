import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";
import { apiUrl, layout, originSettings } from "../src/origins.js";

function config(source: string): Config {
  const result = parseConfig(source);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.config;
}

const base = `version: 1
project: acme
domain: example.turbovibe.ai
`;
const api = `  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile }
`;
const web = (target: string, extra = "") => `  web:
    kind: frontend
    target: ${target}
${extra}    build: { command: "pnpm build", output: dist }
`;
const split = config(
  `${base}environments:
  staging: { hostname: staging-example.turbovibe.ai, api_hostname: api-staging-example.turbovibe.ai }
  production: { api_hostname: api-example.turbovibe.ai }
services:
${api}${web("vercel-static")}`,
);

describe("originSettings", () => {
  it("allows exactly the frontend URL of the same environment, never a wildcard", () => {
    expect(originSettings(split, "staging")).toEqual({
      allowedOrigins: ["https://staging-example.turbovibe.ai"],
      frontendUrl: "https://staging-example.turbovibe.ai",
    });
    expect(originSettings(split, "production")?.allowedOrigins).toEqual([
      "https://example.turbovibe.ai",
    ]);
    for (const environment of ["staging", "production"] as const) {
      expect(
        originSettings(split, environment)?.allowedOrigins.join(),
      ).not.toContain("*");
    }
  });

  it("sets no cross-origin rules when the frontend is served with its backend", () => {
    const shared = config(
      `${base}services:\n${api}${web("cloudflare-static", "    serve_with: api\n")}`,
    );
    expect(originSettings(shared, "staging")).toBeUndefined();
    expect(layout(shared, "staging")).toEqual({
      hostname: "staging.example.turbovibe.ai",
      backendHostname: "staging.example.turbovibe.ai",
      crossOrigin: false,
    });
  });

  it("sets none for a frontend with no backend", () => {
    expect(
      originSettings(
        config(`${base}services:\n${web("vercel-static")}`),
        "staging",
      ),
    ).toBeUndefined();
  });

  it("sets no cookie domain, so sign-in cookies stay on the API's own host", () => {
    const nested = config(`${base}services:\n${api}${web("vercel-static")}`);
    for (const environment of ["staging", "production"] as const) {
      expect(originSettings(split, environment)).not.toHaveProperty(
        "cookieDomain",
      );
      expect(originSettings(nested, environment)).not.toHaveProperty(
        "cookieDomain",
      );
    }
  });
});

describe("apiUrl", () => {
  it("gives the frontend its own environment's backend", () => {
    expect(apiUrl(split, "staging")).toBe(
      "https://api-staging-example.turbovibe.ai",
    );
    expect(apiUrl(split, "production")).toBe(
      "https://api-example.turbovibe.ai",
    );
  });

  it("is relative when frontend and backend share an origin", () => {
    const shared = config(
      `${base}services:\n${api}${web("cloudflare-static", "    serve_with: api\n")}`,
    );
    expect(apiUrl(shared, "production")).toBe("");
  });
});
