/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'" }
        ]
      }
    ];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb"
    }
  },
  webpack: (config) => {
    config.module = config.module ?? {};
    config.module.parser = config.module.parser ?? {};
    config.module.parser.javascript = {
      ...(config.module.parser.javascript ?? {}),
      url: false
    };
    return config;
  }
};

export default nextConfig;
