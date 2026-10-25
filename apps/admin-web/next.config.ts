import { resolve } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(__dirname, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
