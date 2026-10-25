import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/noto-sans-sc/wght.css";
import { FeedbackToastProvider } from "./components/feedback-toast";
import { GlobalLoadingIndicator } from "./components/global-loading-indicator";
import { PlatformBrandingProvider } from "./components/platform-branding";
import { getPlatformBranding } from "./lib/platform-branding-server";
import { MvpSessionProvider } from "./lib/use-mvp-session";
import "./styles.css";

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getPlatformBranding();
  return {
    title: branding.name,
    description: "企业与集团自托管内容协作系统",
    icons: {
      icon: branding.logoDataUrl ?? "/platform-mark.svg",
      apple: branding.logoDataUrl ?? "/platform-mark.svg",
    },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const branding = await getPlatformBranding();
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <PlatformBrandingProvider initial={branding}>
          <MvpSessionProvider>
            <FeedbackToastProvider>
              {children}
              <GlobalLoadingIndicator />
            </FeedbackToastProvider>
          </MvpSessionProvider>
        </PlatformBrandingProvider>
      </body>
    </html>
  );
}
