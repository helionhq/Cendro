import { expect, test } from "vitest";
import { GET } from "./route";

test("reports healthy", async () => {
  const response = await GET();

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
