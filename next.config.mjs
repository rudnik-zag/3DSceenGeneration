/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb"
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
