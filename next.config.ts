import type { NextConfig } from 'next';
const config: NextConfig = {
 poweredByHeader: false,
 agentRules: false,
 reactStrictMode: true,
 serverExternalPackages: ['pino', 'pino-pretty'],
 experimental: { cpus: 2, webpackBuildWorker: false },
};
export default config;
