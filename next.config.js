/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
  experimental: {
    serverComponentsExternalPackages: ["onnxruntime-web"],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      if (!config.externals) config.externals = [];
      config.externals.push("onnxruntime-web");
    }

    // onnxruntime-web bundles use import.meta which Terser (CJS mode) can't parse.
    // Pre-process onnxruntime-web files: strip import.meta before Terser sees them.
    if (!isServer) {
      config.module = config.module || {};
      config.module.rules = config.module.rules || [];

      // Custom loader: replaces import.meta with a safe runtime expression
      const loaderPath = require("path").resolve(
        __dirname,
        "webpack-loader-import-meta.js"
      );
      config.module.rules.unshift({
        test: /\.m?js$/,
        include: /node_modules[/\\]onnxruntime-web/,
        use: [{ loader: loaderPath }],
      });

      // Handle WASM files from onnxruntime-web
      config.module.rules.push({
        test: /\.wasm$/,
        type: "asset/resource",
        generator: {
          filename: "static/wasm/[name][ext]",
        },
      });
    }

    // Support web workers
    config.resolve.alias = config.resolve.alias || {};

    return config;
  },
};

module.exports = nextConfig;
