import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";
import { derivePlan, formatPlan } from "../src/plan.js";

function config(source: string): Config {
  const result = parseConfig(source);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.config;
}

const backendOnly = `version: 1
project: acme
domain: acme.example.com
services:
  api:
    kind: backend
    target: cloudflare-container
    build: { dockerfile: Dockerfile }
`;

describe("derivePlan", () => {
  it("plans a backend-only config with nothing but that backend in each environment", () => {
    expect(derivePlan(config(backendOnly))).toEqual([
      {
        environment: "staging",
        hostname: "staging.acme.example.com",
        services: [
          {
            name: "api",
            kind: "backend",
            target: "cloudflare-container",
            url: "https://staging.acme.example.com/api/",
          },
        ],
      },
      {
        environment: "production",
        hostname: "acme.example.com",
        services: [
          {
            name: "api",
            kind: "backend",
            target: "cloudflare-container",
            url: "https://acme.example.com/api/",
          },
        ],
      },
    ]);
  });

  it("uses an environment's configured hostname", () => {
    const plan = derivePlan(
      config(
        `${backendOnly}environments:\n  staging: { hostname: preprod.acme.example.com }\n`,
      ),
    );
    expect(plan[0]?.hostname).toBe("preprod.acme.example.com");
  });

  it("serves a frontend at the root of its backend's hostname", () => {
    const plan = derivePlan(
      config(
        `${backendOnly}  web:\n    kind: frontend\n    target: cloudflare-static\n    serve_with: api\n    build: { command: "pnpm build", output: dist }\n`,
      ),
    );
    expect(plan[0]?.services[1]).toEqual({
      name: "web",
      kind: "frontend",
      target: "cloudflare-static",
      url: "https://staging.acme.example.com/",
      servedWith: "api",
    });
  });
});

describe("formatPlan", () => {
  it("lists a service's secret names under it, and never a value", () => {
    const text = formatPlan(
      derivePlan(
        config(
          backendOnly.replace(
            "    target: cloudflare-container\n",
            "    target: cloudflare-container\n    secrets: [STRIPE_SECRET_KEY, POSTMARK_TOKEN]\n",
          ),
        ),
      ),
    );
    expect(text).toContain(
      "  api  backend  cloudflare-container  https://staging.acme.example.com/api/\n    secrets: STRIPE_SECRET_KEY, POSTMARK_TOKEN\n",
    );
  });

  it("lists each environment with its services", () => {
    expect(formatPlan(derivePlan(config(backendOnly)))).toBe(
      [
        "staging (staging.acme.example.com)",
        "  api  backend  cloudflare-container  https://staging.acme.example.com/api/",
        "",
        "production (acme.example.com)",
        "  api  backend  cloudflare-container  https://acme.example.com/api/",
      ].join("\n"),
    );
  });
});
