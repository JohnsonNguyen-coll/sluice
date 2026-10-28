import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
const config: NextConfig = {
 outputFileTracingRoot: fileURLToPath(new URL('..', import.meta.url)),
 poweredByHeader: false,
 agentRules: false,
 reactStrictMode: true,
 serverExternalPackages: ['pino', 'pino-pretty'],
 experimental: { cpus: 2, webpackBuildWorker: false },
};
export default config;
