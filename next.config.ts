import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["devbox.tail5bb70e.ts.net"],
  env: {
    // The deploy workflow sets the commit SHA.
    NEXT_PUBLIC_APP_BUILD: process.env.NEXT_PUBLIC_APP_BUILD ?? "local",
  },
};
export default nextConfig;
