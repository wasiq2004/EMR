import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Self-contained server for the container: Next traces the modules the app
  // actually imports, so the runtime image carries a fraction of node_modules.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),

  // Zod schemas are shared as source, so Next must compile the workspace package.
  transpilePackages: ['@emr/contracts'],

  typedRoutes: true,

  // The web tier renders UI and proxies auth; it never talks to the database.
  // Clinical reads go through the API, which is the only thing holding a
  // tenant-scoped connection.
  env: {
    NEXT_PUBLIC_APP_NAME: 'Clinic EMR',
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
