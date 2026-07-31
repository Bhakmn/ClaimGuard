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
  title: "ClaimGuard · AI Copyright Cleaner",
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
      <head>
        {/*
         * Safari workaround for a Next.js hydration-timing bug.
         *
         * Next's markHydrateComplete() calls:
         *   performance.measure('Next.js-before-hydration', 'navigationStart', 'beforeRender')
         *
         * Chrome accepts the legacy PerformanceTiming attribute name
         * 'navigationStart' as a start-mark; Safari does not — it requires a
         * real user-timing mark with that name and throws TypeError otherwise.
         * Next.js guards the 'beforeRender' mark but not the 'navigationStart'
         * one, and the fix has not landed in any 16.x patch release.
         *
         * We create the mark ourselves, early in the document, so it exists by
         * the time hydration completes.  Guards: browser-only, API present,
         * no pre-existing entry with this name (avoids duplicates on engines
         * that already register it).
         */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
(function(){
  if(typeof performance==='undefined'||typeof performance.mark!=='function') return;
  if(performance.getEntriesByName('navigationStart','mark').length===0)
    performance.mark('navigationStart');
})();
`.trim(),
          }}
        />
      </head>
      <body
        className={`${cormorant.variable} ${courierPrime.variable} ${dmSans.variable}`}
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
