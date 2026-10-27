/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Royal blue scale (primary) + navy `ink` surfaces. `gold`/`coral`/`sun` names are kept for existing pages but now resolve to the logo's electric cyan.
        brand: { 50: '#eff4ff', 100: '#dce7ff', 200: '#bfd2ff', 300: '#93b3fb', 400: '#6189f2', 500: '#3b64e0', 600: '#2a4cc4', 700: '#223d9c', 800: '#1d3380', 900: '#182a66' },
        ink: { 700: '#1a2750', 800: '#111b3d', 900: '#0a1230', 950: '#060b21' },
        // `coral` / `sun` keep their names (used across pages) but now resolve to the single warm accent: antique gold.
        coral: { 400: '#35c4ff', 500: '#0ea5ee', 600: '#0678b8' },
        sun: { 400: '#6fd6ff', 500: '#35c4ff' },
        gold: { 300: '#8fdcff', 400: '#35c4ff', 500: '#0ea5ee', 600: '#0678b8' },
        ivory: { 50: '#fafcff', 100: '#f2f7fe', 200: '#e5eefa' },
      },
      fontFamily: {
        sans: ['"Figtree Variable"', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        // Editorial serif for headings; data/UI text stays in Figtree.
        display: ['"Source Serif 4 Variable"', 'Georgia', '"Times New Roman"', 'serif'],
        ui: ['"Figtree Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glass: '0 1px 2px rgba(10, 18, 48, 0.05), 0 8px 24px -12px rgba(10, 18, 48, 0.12)',
        glow: '0 10px 30px -10px rgba(34, 61, 156, 0.55)',
        lift: '0 20px 44px -18px rgba(10, 18, 48, 0.32)',
      },
      keyframes: {
        float: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-14px)' } },
        'float-slow': { '0%,100%': { transform: 'translate(0,0) scale(1)' }, '50%': { transform: 'translate(24px,-18px) scale(1.06)' } },
        sheen: { from: { transform: 'translateX(-120%) skewX(-18deg)' }, to: { transform: 'translateX(320%) skewX(-18deg)' } },
        shake: { '0%,100%': { transform: 'translateX(0)' }, '20%,60%': { transform: 'translateX(-5px)' }, '40%,80%': { transform: 'translateX(5px)' } },
        'gradient-pan': { '0%,100%': { backgroundPosition: '0% 50%' }, '50%': { backgroundPosition: '100% 50%' } },
        'logo-breathe': { '0%,100%': { transform: 'scale(1)' }, '50%': { transform: 'scale(1.045)' } },
        'ring-spin': { to: { transform: 'rotate(360deg)' } },
        'load-bar': { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(260%)' } },
        'glow-pulse': { '0%,100%': { opacity: '0.45', transform: 'scale(0.92)' }, '50%': { opacity: '0.9', transform: 'scale(1.08)' } },
        marquee: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
        'ken-burns': { from: { transform: 'scale(1.04)' }, to: { transform: 'scale(1.14) translate(-1.2%,-1%)' } },
      },
      animation: {
        float: 'float 6s ease-in-out infinite',
        'float-slow': 'float-slow 14s ease-in-out infinite',
        sheen: 'sheen 1.1s ease-in-out',
        shake: 'shake 0.4s ease-in-out',
        'gradient-pan': 'gradient-pan 12s ease infinite',
        'logo-breathe': 'logo-breathe 2.4s ease-in-out infinite',
        'ring-spin': 'ring-spin 1.6s linear infinite',
        'load-bar': 'load-bar 1.5s cubic-bezier(.4,0,.2,1) infinite',
        'glow-pulse': 'glow-pulse 2.4s ease-in-out infinite',
        'ken-burns': 'ken-burns 28s ease-in-out infinite alternate',
        marquee: 'marquee 45s linear infinite',
      },
    },
  },
  plugins: [
    // height-based variants so desktop/laptop screens with little vertical room can tighten up (short <= 820px, tiny <= 700px)
    ({ addVariant }) => {
      addVariant('short', '@media (max-height: 820px)');
      addVariant('tiny', '@media (max-height: 700px)');
    },
  ],
};
