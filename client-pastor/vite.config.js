import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
      registerType: 'autoUpdate',
      // The icons the browser and the launcher read, plus the roundel the app
      // itself renders (VrtLogo) and the PWA's offline shell needs cached.
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'vrt-logo.png', 'vrt-roundel.png'],
      manifest: {
        name: 'VRT Pastor',
        short_name: 'VRT Pastor',
        description: "Real-time attendance, offerings and emergency alerts for Victory Revival Temple's Reverend Pastor.",
        theme_color: '#F6F2E9',
        background_color: '#FDFBF6',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        // Real sizes, not 'any': a launcher picks by size, and a correctly
        // sized icon is what makes the installed app show the VRT roundel
        // instead of a scaled-down wordmark. The maskable entry is the same
        // artwork (already opaque paper with the roundel inside the safe
        // zone, see scripts/make-app-icons.js), which is what keeps the ring
        // whole when Android crops the icon to its own shape.
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
