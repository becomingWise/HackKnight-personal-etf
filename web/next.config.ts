import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Shaun's paper-trading Lab: one static page (copied by `pnpm sync:lab`) that routes itself.
  async rewrites() {
    return ["/lab", "/lab/basket", "/lab/events"].map((source) => ({
      source,
      destination: "/lab-static/index.html",
    }));
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
