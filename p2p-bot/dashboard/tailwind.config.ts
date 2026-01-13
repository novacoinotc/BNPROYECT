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
          50: '#fef7e7',
          100: '#fdebc3',
          200: '#fbd98f',
          300: '#f9c756',
          400: '#f7b72a',
          500: '#f0b90b', // Binance yellow
          600: '#d9a509',
          700: '#b48508',
          800: '#93690a',
          900: '#79560b',
        },
      },
    },
  },
  plugins: [],
};

export default config;
