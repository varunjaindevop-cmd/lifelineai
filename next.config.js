/** @type {import('next').NextConfig} */

// Webpack minimizer compatible with import.meta (onnxruntime-web WebGPU backend).
// Delegates to terser with ecma:2020 + module:true.
class ESMCompatMinimizer {
  async minify({ code, map, filename }) {
    const { minify } = require('terser');
    const result = await minify(code, {
      ecma: 2020,
      module: true,
      compress: { ecma: 2020 },
      mangle: { ecma: 2020 },
      sourceMap: map ? { content: map, url: filename } : undefined,
    });
    return {
      code: result.code,
      map: result.map ? { mappings: result.map.mappings, sources: result.map.sources } : undefined,
      errors: result.errors || [],
      warnings: result.warnings || [],
    };
  }
}

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
    if (isServer) {
      if (!config.externals) config.externals = [];
      config.externals.push('onnxruntime-web');
    }

    // Swap the JS minimizer so import.meta doesn't crash the build
    if (!dev && config.optimization?.minimizer) {
      config.optimization.minimizer = config.optimization.minimizer.map((m) => {
        if (m && m.constructor && m.constructor.name === 'CssMinimizerPlugin') return m;
        return new ESMCompatMinimizer();
      });
    }

    return config;
  },
};

module.exports = nextConfig;
