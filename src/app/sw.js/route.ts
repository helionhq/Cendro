import { readFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-static";

// Baked per build: each deploy serves different worker bytes, so browsers see a
// real update even when the app — not the worker script — changed.
const BUILD_VERSION =
  process.env.NEXT_PUBLIC_APP_BUILD ?? "dev";

export function GET() {
  const source = readFileSync(join(process.cwd(), "src/app/sw.js/worker.js"), "utf8");
  return new Response(source.replaceAll("__CENDRO_BUILD__", BUILD_VERSION), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}
