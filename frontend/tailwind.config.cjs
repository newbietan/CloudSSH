const path = require('node:path');
const forms = require('@tailwindcss/forms');
const containerQueries = require('@tailwindcss/container-queries');

// Theme V4 stores complete CSS colors (including rgba), not RGB channel lists.
const color = (token) => ({ opacityValue } = {}) =>
  opacityValue === undefined
    ? `var(${token})`
    : `color-mix(in srgb, var(${token}) calc(${opacityValue} * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [path.join(__dirname, 'index.html'), path.join(__dirname, 'src/**/*.{js,ts,jsx,tsx}')],
  theme: {
    extend: {
      colors: {
        background: color('--bg'),
        elevated: color('--bg-elevated'),
        'on-surface': color('--on-surface'),
        'on-surface-variant': color('--on-surface-variant'),
        'outline-variant': color('--border-strong'),
        'primary-container': color('--accent'),
        'on-primary-fixed': color('--on-accent'),
        surface: color('--bg-surface'),
        'surface-variant': color('--surface-dot'),
        'secondary-container': color('--accent-secondary'),
        'secondary-fixed': color('--accent-secondary-light'),
        error: color('--error'),
        'error-container': color('--error-bg'),
        'surface-container-lowest': color('--bg-terminal'),
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
