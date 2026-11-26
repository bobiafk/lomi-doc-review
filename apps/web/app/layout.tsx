import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Sidebar } from "../components/sidebar";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Lomi Review",
  description: "Review LLM-extracted values against their source evidence.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="shell">
            <Sidebar />
            <main className="main">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
