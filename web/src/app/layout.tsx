import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { SolanaProvider } from "@/components/SolanaProvider";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Yield AI",
  description: "AI-managed Solana vault",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-background text-foreground min-h-screen`}>
        <SolanaProvider>{children}</SolanaProvider>
      </body>
    </html>
  );
}
