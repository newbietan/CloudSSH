const path = require('node:path');
const forms = require('@tailwindcss/forms');
const containerQueries = require('@tailwindcss/container-queries');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [path.join(__dirname, 'index.html'), path.join(__dirname, 'src/**/*.{js,ts,jsx,tsx}')],
  theme: {
    extend: {
      colors: {
        background: 'var(--bg)',
        elevated: 'var(--bg-elevated)',
        'on-surface': 'var(--on-surface)',
        'on-surface-variant': 'var(--on-surface-variant)',
        'outline-variant': 'var(--border-strong)',
        'primary-container': 'var(--accent)',
        'on-primary-fixed': 'var(--on-accent)',
        surface: 'var(--bg-surface)',
        'surface-variant': 'var(--surface-dot)',
        'secondary-container': 'var(--accent-secondary)',
        'secondary-fixed': 'var(--accent-secondary-light)',
        error: 'var(--error)',
        'error-container': 'var(--error-bg)',
        'surface-container-lowest': 'var(--bg-terminal)',
      },
      fontFamily: {
        body: ['var(--font-ui)'],
        headline: ['var(--font-ui)'],
        label: ['var(--font-ui)'],
        code: ['var(--font-code)'],
      },
    },
  },
  plugins: [forms, containerQueries],
};
