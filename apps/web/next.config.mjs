import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next が next dev のたびに AGENTS.md を生成するのを止める。
  agentRules: false,
  // contracts と analysis は TS のソースをそのまま公開しているので Next 側で変換する。
  transpilePackages: ['@llm-vap/contracts', '@llm-vap/analysis'],
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
