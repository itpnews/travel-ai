/** @type {import('next').NextConfig} */
const nextConfig = {
  // Compile workspace packages through Next.js/SWC bundler.
  // This avoids the need to pre-build @travel-ai/types before running dev.
  transpilePackages: ['@travel-ai/types'],
};

export default nextConfig;
