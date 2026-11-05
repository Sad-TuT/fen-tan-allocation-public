import type { MetadataRoute } from "next";

// 这是私人账簿工具，不提供公开内容，全部禁止抓取。
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
