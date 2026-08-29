import type { NextConfig } from 'next';

// Dev-прокси (харднинг M4-2): beacon шлёт на относительный /api/v1/events;
// без Caddy (web:3000) это 404. В prod проксирование делает Caddy (AN-10).
const devRewrites =
  process.env.NODE_ENV === 'production'
    ? []
    : [
        {
          source: '/api/v1/:path*',
          destination: `${process.env.API_ORIGIN ?? 'http://localhost:4000'}/api/v1/:path*`,
        },
      ];

const nextConfig: NextConfig = {
  // @tas/* публикуют TS-исходники (main: src/index.ts) — транслируем:
  transpilePackages: ['@tas/shared'],
  // серверные пакеты не бандлим (нативные/сетевые зависимости):
  serverExternalPackages: ['@tas/db', 'ioredis', '@prisma/client'],
  async rewrites() {
    return devRewrites;
  },
  webpack: (config) => {
    // NodeNext-стиль импортов '*.js' внутри TS-пакетов → резолв в .ts:
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.js'],
      '.cjs': ['.cjs', '.ts'],
    };
    return config;
  },
};

export default nextConfig;
