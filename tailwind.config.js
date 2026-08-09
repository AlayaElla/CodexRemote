const uiFontFamily = ['Microsoft YaHei UI', 'Segoe UI', 'Inter', 'sans-serif'];
const monoFontFamily = ['Cascadia Mono', 'JetBrains Mono', 'Consolas', 'Microsoft YaHei UI', 'sans-serif'];

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/ui/app.html', './src/ui/renderer.js'],
  theme: {
    extend: {
      colors: {
        background: '#f5f5f7',
        error: '#ff3b30',
        'error-container': '#fff0ee',
        'inverse-on-surface': '#f5f5f7',
        'inverse-primary': '#9dceff',
        'inverse-surface': '#1d1d1f',
        'on-background': '#1d1d1f',
        'on-error': '#ffffff',
        'on-error-container': '#b42318',
        'on-primary': '#ffffff',
        'on-primary-container': '#005bb5',
        'on-primary-fixed': '#004a94',
        'on-primary-fixed-variant': '#0071e3',
        'on-secondary': '#ffffff',
        'on-secondary-container': '#e8e8ed',
        'on-secondary-fixed': '#1d1d1f',
        'on-secondary-fixed-variant': '#6e6e73',
        'on-surface': '#1d1d1f',
        'on-surface-variant': '#6e6e73',
        'on-tertiary': '#ffffff',
        'on-tertiary-container': '#838487',
        'on-tertiary-fixed': '#1a1c1e',
        'on-tertiary-fixed-variant': '#454749',
        outline: '#86868b',
        'outline-variant': '#d2d2d7',
        primary: '#0071e3',
        'primary-container': '#e8f3ff',
        'primary-fixed': '#e8f3ff',
        'primary-fixed-dim': '#cce5ff',
        secondary: '#5d5e60',
        'secondary-container': '#dfdfe0',
        'secondary-fixed': '#e2e2e3',
        'secondary-fixed-dim': '#c6c6c7',
        success: '#34c759',
        'success-container': '#eaf9ee',
        'on-success-container': '#1f7a36',
        warning: '#ff9f0a',
        'warning-container': '#fff4e0',
        'on-warning-container': '#9a5b00',
        info: '#007aff',
        'info-container': '#eaf4ff',
        'on-info-container': '#0060c9',
        surface: '#f5f5f7',
        'surface-bright': '#ffffff',
        'surface-container': '#f2f2f7',
        'surface-container-high': '#e8e8ed',
        'surface-container-highest': '#d2d2d7',
        'surface-container-low': '#fbfbfd',
        'surface-container-lowest': '#ffffff',
        'surface-dim': '#e8e8ed',
        'surface-tint': '#0071e3',
        'surface-variant': '#e8e8ed',
        tertiary: '#000000',
        'tertiary-container': '#1a1c1e',
        'tertiary-fixed': '#e2e2e5',
        'tertiary-fixed-dim': '#c6c6c9'
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        lg: '0.5rem',
        xl: '0.75rem',
        full: '9999px'
      },
      spacing: {
        'element-padding-x': '16px',
        'element-padding-y': '12px',
        unit: '4px',
        'card-gap': '16px',
        'container-padding': '32px'
      },
      fontFamily: {
        'label-mono': monoFontFamily,
        'headline-display': uiFontFamily,
        'body-sm': uiFontFamily,
        'caption-mono': monoFontFamily,
        'body-main': uiFontFamily,
        'headline-section': uiFontFamily
      },
      fontSize: {
        'label-mono': ['12px', { lineHeight: '16px', letterSpacing: '0', fontWeight: '500' }],
        'headline-display': ['22px', { lineHeight: '28px', letterSpacing: '0', fontWeight: '600' }],
        'body-sm': ['13px', { lineHeight: '19px', letterSpacing: '0', fontWeight: '400' }],
        'caption-mono': ['11px', { lineHeight: '14px', letterSpacing: '0', fontWeight: '400' }],
        'body-main': ['14px', { lineHeight: '21px', letterSpacing: '0', fontWeight: '400' }],
        'headline-section': ['17px', { lineHeight: '24px', letterSpacing: '0', fontWeight: '600' }]
      },
      boxShadow: {
        panel: '0 1px 2px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.06)',
        'panel-hover': '0 2px 4px rgba(0, 0, 0, 0.05), 0 14px 32px rgba(0, 0, 0, 0.10)'
      }
    }
  },
  plugins: [require('@tailwindcss/forms')]
};
