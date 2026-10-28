import type { NextConfig } from "next";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || ''

const nextConfig: NextConfig = {
  // Fully static client-rendered app: `next build` emits out/ with one HTML per
  // route; no Node runtime, no Server Actions, no dynamic routes.
  output: 'export',
  allowedDevOrigins: ['127.0.0.1'],
  // Anonymous mirror subpath deploy (leerediary.github.io/orbit): set via
  // NEXT_PUBLIC_BASE_PATH=/orbit. Empty string = no-op (root/private builds).
  ...(BASE_PATH ? { basePath: BASE_PATH, assetPrefix: BASE_PATH } : {}),
};

export default nextConfig;
