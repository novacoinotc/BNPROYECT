import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'P2P Trading Bot Dashboard',
  description: 'Real-time monitoring for Binance P2P Trading Bot',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body className={inter.className}>
        <Providers>
          <div className="min-h-screen bg-[#181a20]">
            {/* Header */}
            <header className="bg-[#1e2026] border-b border-[#2b2f36]">
              <div className="container mx-auto px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-primary-500 rounded-full flex items-center justify-center">
                      <span className="text-black font-bold text-sm">P2P</span>
                    </div>
                    <h1 className="text-xl font-semibold text-white">
                      Trading Bot
                    </h1>
                  </div>
                  <nav className="flex items-center gap-6">
                    <a href="/" className="text-gray-400 hover:text-white transition">
                      Dashboard
                    </a>
                    <a href="/orders" className="text-gray-400 hover:text-white transition">
                      Orders
                    </a>
                    <a href="/settings" className="text-gray-400 hover:text-white transition">
                      Settings
                    </a>
                  </nav>
                </div>
              </div>
            </header>

            {/* Main Content */}
            <main className="container mx-auto px-4 py-6">
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
