import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@sotama/ui", "@sotama/market-core", "@sotama/db"],
  // Keep server bundle thin: pg uses dynamic native bindings only on
  // request. Avoid bundling it client-side.
  serverExternalPackages: ["pg"],
};

export default config;
