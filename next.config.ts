import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "sharp"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
