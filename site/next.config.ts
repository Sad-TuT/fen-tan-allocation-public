import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // 不暴露框架名与版本，减少指纹信息。
  poweredByHeader: false,
  // 本地源码副本的依赖位于外层目录；生产安装时保持默认根目录。
  turbopack: process.env.NEXT_TURBOPACK_ROOT
    ? { root: path.resolve(process.env.NEXT_TURBOPACK_ROOT) }
    : undefined,
};

export default nextConfig;
