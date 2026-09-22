import type { Metadata, Viewport } from 'next';
import { Atkinson_Hyperlegible, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { THEME_INIT_SCRIPT, ThemeProvider } from '@/lib/theme';

/**
 * Atkinson Hyperlegible is chosen for letterform disambiguation, not style:
 * 1/l/I and 0/O are drawn to be distinct. Staff read drug names, strengths and
 * dosage patterns like "1-0-1" at speed here, and a misread is a clinical error
 * rather than a typo.
 */
const sans = Atkinson_Hyperlegible({
  weight: ['400', '700'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-atkinson',
  fallback: ['system-ui', 'Segoe UI', 'sans-serif'],
});

/** Identifiers, dosages and money — anything that must line up or not reflow. */
const mono = IBM_Plex_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-plex-mono',
  fallback: ['ui-monospace', 'Menlo', 'monospace'],
});

export const metadata: Metadata = {
  /*
   * The product, not a clinic.
   *
   * This is a multi-tenant deployment and this metadata is rendered before any
   * session exists, so it cannot know whose clinic this is — naming one meant
   * every clinic's browser tab, bookmark and shared screenshot carried another
   * clinic's name.
   */
  title: {
    default: 'Clinic EMR',
    template: '%s · Clinic EMR',
  },
  description: 'Clinic records, queue and prescriptions.',
  // A clinical record must never be indexed or previewed by anything external.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Pinch-zoom stays available. Disabling it is an accessibility failure, and
  // this product has a stated WCAG 2.2 AA target on core flows.
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f6f7' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1518' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/*
          Blocking, and before anything paints. It reads the saved theme and
          stamps data-theme on <html> so the correct palette is in force for the
          FIRST frame. Without it, anyone who chose dark gets a white flash on
          every navigation — which is worse than having no switcher at all.

          suppressHydrationWarning on <html> because this script legitimately
          mutates the element before React sees it.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:text-accent-contrast"
        >
          Skip to main content
        </a>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
