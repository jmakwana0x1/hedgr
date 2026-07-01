import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hedgr",
  description:
    "Cross-venue hedge discovery and execution across Polymarket and Uniswap, driven by AI agents over MCP.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
