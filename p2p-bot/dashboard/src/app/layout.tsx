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
          <div className="min-h-screen bg-gradient-dark">
            {/* Header */}
            <header className="bg-dark-card/80 backdrop-blur-md border-b border-dark-border sticky top-0 z-50">
              <div className="container mx-auto px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-gradient-to-br from-primary-500 to-primary-700 rounded-lg flex items-center justify-center shadow-lg">
                      <span className="text-white font-bold text-sm">P2P</span>
                    </div>
                    <h1 className="text-xl font-semibold text-white">
                      Trading Bot
                    </h1>
                  </div>
                  <nav className="flex items-center gap-1">
                    <a href="/" className="px-4 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-dark-hover transition-all">
                      Dashboard
                    </a>
                    <a href="/orders" className="px-4 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-dark-hover transition-all">
                      Orders
                    </a>
                    <a href="/pending-payments" className="px-4 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-dark-hover transition-all">
                      Terceros
                    </a>
                    <a href="/trusted-buyers" className="px-4 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-dark-hover transition-all">
                      Trusted
                    </a>
                    <a href="/settings" className="px-4 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-dark-hover transition-all">
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
