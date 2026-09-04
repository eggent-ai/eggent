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
  serverExternalPackages: [
    "child_process",
    "pdfjs-dist",
    "@earendil-works/pi-coding-agent",
    "typebox",
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
    // Any request that passes through middleware — which is every request
    // here, the matcher is "/:path*" — is buffered whole before the route sees
    // it. The default ceiling is 10 MB, and past it the framework keeps the
    // first 10 MB and drops the rest, so an upload larger than that arrives as
    // a truncated multipart body and dies as a parse error with nothing on
    // screen. Must stay equal to MAX_UPLOAD_BYTES in
    // src/lib/files/upload-limits.ts; npm run test:upload-limit checks that.
    middlewareClientMaxBodySize: "100mb",
  },
};

export default nextConfig;
