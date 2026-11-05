import type { NextConfig } from "next";
import path from "node:path";
import {
  edgeSecurityHeadersEnabled,
  securityHeadersForDeployment,
} from "./app/lib/security-policy.ts";

const nextConfig: NextConfig = {
  // Let verification builds use an isolated, ignored output directory while
  // the live local preview keeps its own development cache.
  distDir: process.env.ALLOCATION_BUILD_DIR || ".next",
  // 不暴露框架名与版本，减少指纹信息。
  poweredByHeader: false,
  // 本地源码副本的依赖位于外层目录；生产安装时保持默认根目录。
  turbopack: process.env.NEXT_TURBOPACK_ROOT
    ? { root: path.resolve(process.env.NEXT_TURBOPACK_ROOT) }
    : undefined,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeadersForDeployment(edgeSecurityHeadersEnabled()),
      },
    ];
  },
};

export default nextConfig;
