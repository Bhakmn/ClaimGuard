import type { Metadata } from "next";
import { Cormorant_Garamond, Courier_Prime, DM_Sans } from "next/font/google";
import "./globals.css";

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-cormorant",
  display: "swap",
});

const courierPrime = Courier_Prime({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal"],
  variable: "--font-courier",
  display: "swap",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
  style: ["normal"],
  variable: "--font-dm-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ClaimGuard · Copyright Cleaner",
  description:
    "Flag copyrighted music in short videos, then cut, mute or replace it in a browser timeline editor.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
    >
      <body
        className={`${cormorant.variable} ${courierPrime.variable} ${dmSans.variable}`}
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
