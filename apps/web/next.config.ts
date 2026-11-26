import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The browser only ever talks to this origin: /api/* is proxied to the
// Fastify API, so there is no CORS and no API URL baked into client code.
// Rewrites are resolved at build time (Docker passes API_URL as a build arg).
const apiUrl = process.env["API_URL"] ?? "http://localhost:3001";

const config: NextConfig = {
  output: "standalone",
  // Trace files from the monorepo root so workspace packages land in the standalone build.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
};

export default config;
