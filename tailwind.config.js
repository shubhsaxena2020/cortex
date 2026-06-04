/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/renderer/src/**/*.{js,ts,jsx,tsx}',
    './src/renderer/index.html'
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#1a1a1a',
          secondary: '#2d2d2d',
          tertiary: '#3f3f3f'
        },
        accent: {
          claude: '#6366f1',
          chatgpt: '#10a37f',
          gemini: '#8b5cf6',
          brand: '#3b82f6'
        }
      }
    }
  },
  plugins: []
}
