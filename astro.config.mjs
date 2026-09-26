import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://jipsy-danger.github.io/torrent',
  base: '/torrent',
  build: {
    format: 'directory'
  }
});
