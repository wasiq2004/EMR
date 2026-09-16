import { Providers } from '@/components/providers';

/**
 * The unauthenticated shell: sign-in, two-factor, and the public share-link
 * viewer. No navigation, because there is nowhere to navigate to yet.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers session={null}>
      <div className="flex min-h-dvh flex-col bg-canvas">{children}</div>
    </Providers>
  );
}
