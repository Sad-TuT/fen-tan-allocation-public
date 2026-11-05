import type { Metadata, Viewport } from "next";
import {
  CONTENT_SECURITY_POLICY,
  edgeSecurityHeadersEnabled,
} from "./lib/security-policy.ts";
import "./globals.css";

export const metadata: Metadata = {
  title: "分摊",
  description: "管理金额来源、产品分摊、开票资料与连续批次余额。",
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
            content={CONTENT_SECURITY_POLICY}
          />
        ) : null}
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
