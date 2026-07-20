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
  // Don't bundle onnxruntime-web - it has pre-minified code with import.meta
  serverExternalPackages: ['onnxruntime-web'],
  webpack: (config, { isServer }) => {
    // Handle WASM files
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };

    // Exclude ort.bundle files from Terser minification
    // These files already use import.meta which Terser can't handle
    if (config.optimization?.minimizer) {
      const filteredMinimizers = [];
      for (const minimizer of config.optimization.minimizer) {
        if (minimizer.constructor.name === 'TerserPlugin') {
          // Create new instance with exclude pattern
          const opts = { ...minimizer.options };
          opts.exclude = /ort\.bundle/;
          filteredMinimizers.push(new minimizer.constructor(opts));
        } else {
          filteredMinimizers.push(minimizer);
        }
      }
      config.optimization.minimizer = filteredMinimizers;
    }

    return config;
  },
};

module.exports = nextConfig;
