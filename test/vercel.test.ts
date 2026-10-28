import { expect, it } from "vitest";
// Imported first, before anything that loads the adapter registry, as test/integration/nextjs.test.ts does.
import { vercelNextjs, vercelStatic } from "../src/adapters/vercel.js";

it("loads without the adapter registry having loaded first", async () => {
  expect(vercelStatic.target).toBe("vercel-static");
  const { adapters } = await import("../src/adapters/index.js");
  expect(adapters["vercel-nextjs"]).toBe(vercelNextjs);
});
