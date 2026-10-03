/** @type {import('next').NextConfig} */
const nextConfig = {
  // Prevent webpack from bundling native/WASM modules — they must run in Node.js directly
  serverExternalPackages: ['better-sqlite3', 'sharp', 'tiktoken'],
};

export default nextConfig;
