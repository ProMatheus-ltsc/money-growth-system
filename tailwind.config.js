import animate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './vendor/shared-core/src/**/*.{ts,tsx}',
    '../shared-core/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        fadeIn: 'fadeIn 0.2s ease-out',
        slideUp: 'slideUp 0.2s ease-out',
      },
      transitionDuration: {
        150: '150ms',
        250: '250ms',
        260: '260ms',
      },
      colors: {
        'flow-in': '#10b981',
        'flow-out': '#94a3b8',
        'flow-dec': '#ef4444',
        brand: {
          50: '#f0f4f8',
          100: '#ebf8ff',
          500: '#4299e1',
          700: '#2b6cb0',
          900: '#1a2332',
        },
        chart: {
          1: '#3182ce',
          2: '#e53e3e',
          3: '#38a169',
          4: '#d69e2e',
          5: '#805ad5',
          6: '#dd6b20',
          7: '#319795',
        },
      },
      borderRadius: {
        card: '12px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.04)',
        'input-focus': '0 0 0 3px rgba(66,153,225,0.15)',
      },
      fontSize: {
        'kpi': ['28px', { lineHeight: '1.2', fontWeight: '700' }],
        'kpi-sm': ['20px', { lineHeight: '1.3', fontWeight: '600' }],
      },
    },
  },
  plugins: [animate],
};
