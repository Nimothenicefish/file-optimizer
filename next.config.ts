import type { NextConfig } from "next";
import { ASSET_VERSION } from "./src/lib/asset-version";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "sharp"],
  turbopack: {
    root: __dirname,
  },
  images: {
    // Allows the cache-busting `?v=${ASSET_VERSION}` query on the logo served through next/image.
    localPatterns: [{ pathname: "/logo.png", search: `?v=${ASSET_VERSION}` }],
  },
};

export default nextConfig;
