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


## Universal network adapter

The browser client uses one adapter layer to classify and use the transport methods that a browser can actually provide:

- WebRTC peer transport via WebSocket WebTorrent trackers.
- HTTP(S) web seeds when the torrent provides them.
- Browser HTTPS/fetch for network resources.
- Persistent OPFS/IndexedDB storage for torrent state and pieces.

The same adapter also reports transports that require a native/server component instead of pretending they work in a browser:

- Raw TCP BitTorrent peers.
- Raw UDP/uTP peers.
- Native DHT/other native socket discovery.

This distinction is important because current WebTorrent documentation states that browser WebTorrent uses WebRTC and does not support UDP/TCP peers in the browser.

## Internal diagnostics

The page includes a live diagnostics panel. Use the **Debug** button in the header, or `Ctrl+Shift+J` where the browser allows page-level interception.

The diagnostics show browser network state, adapter availability, per-torrent connectivity, active wire types, tracker/web-seed counts, download progress, and the internal event log.
