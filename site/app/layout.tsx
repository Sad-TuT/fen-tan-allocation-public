import type { Metadata, Viewport } from "next";
import {
  edgeSecurityHeadersEnabled,
  HTML_CONTENT_SECURITY_POLICY,
} from "./lib/security-policy.ts";
import "./globals.css";

export const metadata: Metadata = {
  title: "分摊",
  description: "每批导入资金与产品信息，查看分摊明细、候选文件和剩余资金。",
  // 私人财务工具，不允许被搜索引擎收录。
  robots: { index: false, follow: false, nocache: true },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
  appleWebApp: { capable: true, title: "分摊", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f5f7",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        {edgeSecurityHeadersEnabled() ? (
          <meta
            httpEquiv="Content-Security-Policy"
            content={HTML_CONTENT_SECURITY_POLICY}
          />
        ) : null}
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
