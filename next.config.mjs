/** @type {import("next").NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
  serverExternalPackages: ["child_process", "pdfjs-dist"],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
