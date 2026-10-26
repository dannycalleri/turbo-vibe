import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backendPort, exposedPort } from "../src/port.js";

describe("exposedPort", () => {
  it.each([
    ["the final stage's EXPOSE", "FROM node\nEXPOSE 3000\n", 3000],
    ["a TCP suffix", "FROM node\nEXPOSE 3000/tcp\n", 3000],
    ["the first TCP port", "FROM node\nEXPOSE 3000/udp 4000 5000\n", 4000],
    ["the last EXPOSE", "FROM node\nEXPOSE 3000\nEXPOSE 4000\n", 4000],
    ["a lowercase instruction", "from node\nexpose 3000\n", 3000],
    ["a continued line", "FROM node\nEXPOSE \\\n  3000\n", 3000],
    [
      "no EXPOSE in the final stage",
      "FROM golang AS build\nEXPOSE 5000\nFROM scratch\n",
      undefined,
    ],
    ["a variable", "FROM node\nEXPOSE $PORT\n", undefined],
    ["a UDP port only", "FROM node\nEXPOSE 53/udp\n", undefined],
    [
      "a last EXPOSE without a TCP port",
      "FROM node\nEXPOSE 3000\nEXPOSE 53/udp\n",
      undefined,
    ],
    ["a comment", "FROM node\n# EXPOSE 3000\n", undefined],
    ["no EXPOSE", "FROM node\n", undefined],
  ])("reads %s", (_case, dockerfile, port) => {
    expect(exposedPort(dockerfile)).toBe(port);
  });
});

describe("backendPort", () => {
  async function folder(dockerfile?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "turbo-vibe-port-"));
    if (dockerfile !== undefined)
      await writeFile(join(dir, "Dockerfile"), dockerfile);
    return dir;
  }

  const backend = (port?: number) => ({
    kind: "backend" as const,
    target: "cloudflare-container",
    build: { dockerfile: "Dockerfile" },
    ...(port ? { container: { port } } : {}),
  });

  it("prefers container.port over EXPOSE", async () => {
    const dir = await folder("FROM node\nEXPOSE 3000\n");
    expect(await backendPort(backend(4000), dir)).toEqual({
      port: 4000,
      source: "container.port",
    });
  });

  it("reads EXPOSE from the Dockerfile", async () => {
    const dir = await folder("FROM node\nEXPOSE 3000\n");
    expect(await backendPort(backend(), dir)).toEqual({
      port: 3000,
      source: "EXPOSE in Dockerfile",
    });
  });

  it("falls back to 8080 without EXPOSE or without a Dockerfile", async () => {
    const fallback = { port: 8080, source: "the default" };
    expect(await backendPort(backend(), await folder("FROM node\n"))).toEqual(
      fallback,
    );
    expect(await backendPort(backend(), await folder())).toEqual(fallback);
  });
});
