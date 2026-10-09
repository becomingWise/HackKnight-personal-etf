import type { NextConfig } from "next";

// The FastAPI backend; the browser only ever talks to /api on this origin.
const API_URL = process.env.API_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  rewrites: async () => [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }],
};

export default nextConfig;
