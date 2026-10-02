import { builtinModules } from 'node:module';

const nodeBuiltinModules = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  devIndicators: false,
  webpack(config, { isServer }) {
    if (isServer) {
      config.externals.push(({ request }, callback) => {
        if (request && nodeBuiltinModules.has(request)) {
          return callback(null, `commonjs ${request}`);
        }

        return callback();
      });
    }

    return config;
  },
  async headers() {
    const isProduction = process.env.NODE_ENV === 'production';
    const baseHeaders = [
      {
        key: 'Referrer-Policy',
        value: 'strict-origin-when-cross-origin',
      },
      {
        key: 'X-Content-Type-Options',
        value: 'nosniff',
      },
      {
        key: 'X-Frame-Options',
        value: 'DENY',
      },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=()',
      },
      // Modern browsers removed the XSS auditor; setting 0 disables legacy auditor
      // behavior that could otherwise introduce cross-site info leaks.
      {
        key: 'X-XSS-Protection',
        value: '0',
      },
    ];

    if (isProduction) {
      // HSTS is also set in middleware for non-API routes; adding it here ensures
      // API routes (excluded from the middleware matcher) receive the header too.
      baseHeaders.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      });
    }

    return [
      {
        source: '/:path*',
        headers: baseHeaders,
      },
    ];
  },
};

export default nextConfig;
