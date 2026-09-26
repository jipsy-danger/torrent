import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://jipsy-danger.github.io/torrent',
  base: '/torrent',
  build: {
    format: 'directory'
  },
  vite: {
    build: {
      // The webtorrent bundle is large; don't warn or inline it
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 2000
    },
    optimizeDeps: {
      // Exclude the already-bundled vendor file from Vite's pre-bundling
      exclude: ['../scripts/vendor/webtorrent.min.js']
    }
  }
});
