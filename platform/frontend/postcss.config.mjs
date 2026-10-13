// Tailwind CSS 4 through its PostCSS plugin (ADR-0014). The design tokens live in src/app/globals.css (@theme).
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
