import type { NextConfig } from "next";

// Build hosts set NEXT_PUBLIC_APP_BUILD directly; Vercel sets the commit SHA.
const appBuild =
  process.env.NEXT_PUBLIC_APP_BUILD ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "local";

const nextConfig: NextConfig = {
  // Vercel's adapter conflicts with the standalone finalizer in Next 16.3;
  // Vercel ignores standalone output anyway.
  output: process.env.VERCEL ? undefined : "standalone",
  allowedDevOrigins: ["devbox.tail5bb70e.ts.net"],
  env: {
    NEXT_PUBLIC_APP_BUILD: appBuild,
    // The upgrade API requires Vercel's runtime (vc dev locally).
    NEXT_PUBLIC_CONVEX_RELAY: process.env.VERCEL === "1" ? "true" : "false",
  },
};
export default nextConfig;
