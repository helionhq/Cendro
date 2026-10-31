// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// The build marker is read at module load, so each value needs a fresh import.
async function workerFor(build: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_BUILD", build);
  const { GET } = await import("./route");
  return (await GET()).text();
}

test("serves worker bytes stamped with the current build", async () => {
  const first = await workerFor("build-a");
  const second = await workerFor("build-b");

  expect(first).toContain("build-a");
  expect(second).toContain("build-b");
  expect(first).not.toContain("__CENDRO_BUILD__");
  expect(second).not.toContain("__CENDRO_BUILD__");
  expect(first).not.toBe(second);
});
