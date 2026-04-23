import type { Metadata } from "next";
import { Bricolage_Grotesque, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { AppSidebar } from "@/components/Sidebar";
import { Navbar } from "@/components/Navbar";
import { SidebarProvider, SidebarInset } from "@/components/animate-ui/components/radix/sidebar";
import { Toaster } from "@/components/ui/sonner";

const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Hexos Dashboard",
  description: "Hexos AI Gateway Dashboard",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${bricolage.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background font-sans antialiased" suppressHydrationWarning>
        <ThemeProvider>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset className="min-w-0 overflow-hidden">
              <div className="sticky top-0 z-10 bg-background">
                <Navbar />
              </div>
              <div className="flex-1 overflow-auto p-4 lg:p-6">
                {children}
              </div>
            </SidebarInset>
          </SidebarProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
