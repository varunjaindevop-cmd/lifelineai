/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
      },
    ],
  },
  experimental: {
    // onnxruntime-web uses ESM — exclude from server bundling
    serverComponentsExternalPackages: ['onnxruntime-web'],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push('onnxruntime-web');
    }
    return config;
  },
};

module.exports = nextConfig;
