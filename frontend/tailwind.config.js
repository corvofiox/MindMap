/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        // Morandi color palette for nodes
        morandi: {
          red: '#C8A2A8',
          pink: '#D8B7C7',
          rose: '#E5C9CA',
          orange: '#E5C8A8',
          yellow: '#F0E6C3',
          lime: '#D6E5C8',
          green: '#B8C9BE',
          teal: '#B8D5D1',
          cyan: '#C8DDE0',
          sky: '#C8D5E0',
          blue: '#C8CBDE',
          indigo: '#D1C8DE',
          purple: '#DBC8DE',
          violet: '#DEC8E0',
          magenta: '#DEC8D1',
        },
        // Glass morphism colors
        glass: {
          light: 'rgba(255, 255, 255, 0.7)',
          dark: 'rgba(0, 0, 0, 0.5)',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'PingFang SC',
          'Lantinghei SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
      },
      boxShadow: {
        'glass': '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
        'glass-lg': '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
      },
      backdropBlur: {
        xs: '2px',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'breathe': 'breathe 2s ease-in-out infinite',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.8' },
        },
      },
    },
  },
  plugins: [],
}
