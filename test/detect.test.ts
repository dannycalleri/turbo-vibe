import { describe, expect, it } from "vitest";
import { detectProject, projectName, type Repository } from "../src/detect.js";

const repository = (overrides: Partial<Repository> = {}): Repository => ({
  folder: "shop",
  dockerfile: false,
  supabase: false,
  ...overrides,
});
const manifest = (content: object) => JSON.stringify(content);

describe("detectProject", () => {
  it("offers only the folder's name in an empty repository", () => {
    expect(detectProject(repository())).toEqual({ name: "shop" });
  });

  it("takes the name from package.json before the folder", () => {
    expect(
      detectProject(
        repository({ packageJson: manifest({ name: "@acme/My Shop" }) }),
      ).name,
    ).toBe("my-shop");
  });

  it("reads a backend from a Dockerfile", () => {
    expect(detectProject(repository({ dockerfile: true }))).toEqual({
      name: "shop",
      backend: "cloudflare-container",
      frontend: "none",
      database: "none",
      identity: "none",
    });
  });

  it("reads Next.js before a build script", () => {
    const next = manifest({
      scripts: { build: "next build" },
      dependencies: { next: "15.0.0" },
    });
    expect(detectProject(repository({ packageJson: next })).frontend).toBe(
      "vercel-nextjs",
    );
    const vite = manifest({ scripts: { build: "vite build" } });
    expect(detectProject(repository({ packageJson: vite }))).toMatchObject({
      backend: "none",
      frontend: "cloudflare-static",
    });
  });

  it("reads a database from a supabase folder, and sign-in from a WorkOS SDK", () => {
    expect(
      detectProject(
        repository({
          dockerfile: true,
          supabase: true,
          goMod: "require github.com/workos/workos-go/v4 v4.0.0\n",
        }),
      ),
    ).toMatchObject({ database: "supabase", identity: "workos" });
    expect(
      detectProject(
        repository({
          packageJson: manifest({
            devDependencies: { "@workos-inc/authkit-nextjs": "1.0.0" },
          }),
        }),
      ).identity,
    ).toBe("workos");
  });

  it("ignores a package.json it cannot parse", () => {
    expect(detectProject(repository({ packageJson: "{" })).name).toBe("shop");
    expect(detectProject(repository({ packageJson: "null" })).name).toBe(
      "shop",
    );
  });
});

describe("projectName", () => {
  it("makes a valid project name or none", () => {
    expect(projectName("My Shop")).toBe("my-shop");
    expect(projectName("@acme/web--app_2")).toBe("web-app-2");
    expect(projectName("2048-game")).toBe("game");
    expect(projectName("123")).toBeUndefined();
    expect(projectName("a".repeat(70))).toHaveLength(63);
  });
});
