import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 不暴露框架名与版本，减少指纹信息。
  poweredByHeader: false,
};

export default nextConfig;
