import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @tas/shared публикует TS-исходник (main: src/index.ts) — транслируем:
  transpilePackages: ['@tas/shared'],
};

export default nextConfig;
