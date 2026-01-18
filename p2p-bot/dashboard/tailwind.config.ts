import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6', // Blue - new primary
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        // Dark theme colors - new navy blue theme
        dark: {
          bg: '#0a1018',
          card: '#151d2e',
          border: '#1e2a3e',
          hover: '#1a2438',
        },
      },
      backgroundImage: {
        'gradient-dark': 'linear-gradient(180deg, #0a1018 0%, #0d1421 50%, #0a1018 100%)',
      },
    },
  },
  plugins: [],
};

export default config;
