/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Writes sw.js at build time with the list of built files to precache (the app works offline once loaded). */
function serviceWorker(): Plugin {
  return {
    name: 'numero-sw',
    apply: 'build',
    generateBundle(_, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html').sort()
      const shell = ['./', ...built, 'manifest.webmanifest', 'favicon.svg', 'theme.js', 'icons/icon-192.png', 'icons/icon-512.png', 'geo/world.json', 'geo/usa.json']
        .map((f) => (f === './' ? f : `./${f}`))
      const version = createHash('sha256').update(built.join('\n')).digest('hex').slice(0, 12)
      const source = readFileSync(new URL('./pwa/sw.template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace('__SHELL__', JSON.stringify(shell, null, 2))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

/**
 * Content-Security-Policy for the built app (the dev server needs inline scripts for hot reload, so it has none).
 * Scripts, styles, fonts and workers come from the app's own origin only. Connections are limited to the app itself
 * and to http(s) addresses — the URL imports a user asks for; nothing else in the app makes a request.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // ECharts and the layout set inline style attributes
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' https: http:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'numero-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker(), contentSecurityPolicy()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
  // the data-engine worker lazy-loads SheetJS, so it needs code-splitting (ES module workers)
  worker: { format: 'es' },
  build: {
    // ECharts (~780 KB) is one chunk loaded only when a dataset opens; warn on anything bigger
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: { echarts: ['echarts'], xlsx: ['xlsx'] },
      },
    },
  },
})
