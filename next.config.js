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
    serverComponentsExternalPackages: ['onnxruntime-web'],
  },
  webpack: (config, { isServer, dev }) => {
    // Externalize onnxruntime-web on server side
    if (isServer) {
      if (!config.externals) config.externals = [];
      config.externals.push('onnxruntime-web');
    }

    // Fix: onnxruntime-web uses import.meta.url which crashes Terser.
    // Override the minimizer so Terser parses files as ES modules (ecma 2020).
    if (!dev && config.optimization?.minimizer) {
      const TerserPlugin = require('terser-webpack-plugin');
      config.optimization.minimizer = [
        new TerserPlugin({
          terserOptions: {
            ecma: 2020,
            module: true,
            compress: { ecma: 2020 },
            mangle: { ecma: 2020 },
          },
        }),
      ];
    }

    return config;
  },
};

module.exports = nextConfig;
