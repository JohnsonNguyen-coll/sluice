/** @type {import('tailwindcss').Config} */
export default {
 content: ['./src/**/*.{js,ts,jsx,tsx}'],
 theme: { extend: {
  colors: { background:'var(--bg)',surface:'var(--surface)',foreground:'var(--text)',muted:'var(--muted)',border:'var(--border)',accent:'var(--accent)',success:'var(--success)',warning:'var(--warn)',danger:'var(--danger)' },
  fontFamily: { sans:['Geist Variable','system-ui','sans-serif'], mono:['Geist Mono Variable','monospace'] },
  borderRadius: { DEFAULT:'var(--radius)',lg:'var(--radius-lg)' },
  transitionTimingFunction:{standard:'var(--ease)'},
  transitionDuration:{fast:'160ms',normal:'240ms'},
 }},
 plugins: [],
};
