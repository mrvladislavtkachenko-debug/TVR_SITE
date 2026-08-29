import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @tas/* публикуют TS-исходники (main: src/index.ts) — транслируем:
  transpilePackages: ['@tas/shared'],
  // серверные пакеты не бандлим (нативные/сетевые зависимости):
  serverExternalPackages: ['@tas/db', 'ioredis', '@prisma/client'],
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
