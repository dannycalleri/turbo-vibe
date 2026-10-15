import { describe, expect, it } from "vitest";
import { references } from "../src/version.js";

describe("version references", () => {
  it("follows the major line for a release", () => {
    expect(references("1.4.2")).toEqual({ cliRange: "1", workflowRef: "v1" });
  });

  it("names a prerelease exactly, which neither npm's @1 nor the v1 tag reaches", () => {
    expect(references("1.0.0-rc.1")).toEqual({
      cliRange: "1.0.0-rc.1",
      workflowRef: "v1.0.0-rc.1",
    });
  });
});
