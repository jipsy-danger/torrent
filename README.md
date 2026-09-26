# torrent

Browser torrent downloader built with Astro and WebTorrent.

## Run

```bash
npm install
npm run dev
```

Open the local Astro URL shown by the dev server.

## Persistence

The app stores torrent metadata in IndexedDB and torrent piece data in the browser's Origin Private File System (OPFS). On startup, saved torrents are loaded again. Existing pieces are re-scanned before an interrupted torrent is resumed.

The app requests persistent browser storage where the browser supports it. Normal refreshes and system restarts therefore keep the saved torrent state and stored pieces. Explicit browser/site-data reset or browser uninstall can remove this data.

## Browser torrent transport

The client uses WebTorrent in the browser. Browser WebTorrent uses WebRTC, so a torrent needs WebRTC-capable peers/web seeds to transfer data to a browser client. Normal TCP/UDP-only peers are not directly reachable from the browser.

## Stack

- Astro 7
- WebTorrent 3
- fs-access-chunk-store
- IndexedDB
- Origin Private File System (OPFS)
