import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { resolveBrand } from './src/config/brand.js'

export default defineConfig(({ mode }) => {
  // White-label values (VITE_BRAND_*) for the manifest and index.html; see src/config/brand.js.
  const brand = resolveBrand({ ...loadEnv(mode, process.cwd(), 'VITE_BRAND_'), ...process.env })
  const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  return {
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'brand-html',
      transformIndexHtml: { order: 'pre', handler: html => html
        .replaceAll('%BRAND_TITLE%', escapeHtml(`${brand.appName} - ${brand.tagline}`))
        .replaceAll('%BRAND_ICON%', escapeHtml(brand.icon)) },
    },
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['*.png', '*.svg', '*.ico'],
      manifest: {
        name: brand.appFullName,
        short_name: brand.appName,
        description: 'Point of Sale system for retail shops',
        theme_color: brand.themeColor,
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: brand.logo,
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: brand.logo,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        // Allow larger bundles (jsPDF + html2canvas increase bundle size)
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MiB
        // Cache all app assets (JS bundles, CSS, HTML)
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Cache Supabase API responses for offline fallback
        runtimeCaching: [
          {
            // Supabase REST API — network first, fall back to cache
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api-cache',
              networkTimeoutSeconds: 4,
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 7 // 7 days
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            // Supabase Auth — network first, short cache
            urlPattern: /^https:\/\/.*\.supabase\.co\/auth\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-auth-cache',
              networkTimeoutSeconds: 2,
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 // 1 hour
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ],
        // Don't cache these (they change dynamically)
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/]
      },
      devOptions: {
        // Enable SW in dev mode so you can test offline locally
        enabled: false
      }
    })
  ],
  }
})
