import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "分摊",
  description: "管理金额来源、产品分摊、开票资料与连续批次余额。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
