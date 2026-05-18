import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@sotama/ui", "@sotama/market-core"],
};

export default config;
