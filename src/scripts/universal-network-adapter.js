export const WEBTORRENT_TRACKERS = [
  'wss://tracker.webtorrent.dev:443',
  'wss://tracker.openwebtorrent.com:443',
  'wss://open.ftorrent.com:443'
];

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function trackerProtocols(urls) {
  const result = { ws: 0, wss: 0, http: 0, https: 0, udp: 0, other: 0 };
  for (const raw of unique(urls)) {
    const value = String(raw).toLowerCase();
    if (value.startsWith('wss://')) result.wss++;
    else if (value.startsWith('ws://')) result.ws++;
    else if (value.startsWith('https://')) result.https++;
    else if (value.startsWith('http://')) result.http++;
    else if (value.startsWith('udp://')) result.udp++;
    else result.other++;
  }
  return result;
}

export function createClientOptions() {
  return {
    tracker: {
      announce: WEBTORRENT_TRACKERS
    }
  };
}

export function inspectBrowserNetwork() {
  const online = navigator.onLine !== false;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

  return {
    online,
    webrtc: Boolean(
      typeof RTCPeerConnection === 'function' &&
      typeof RTCDataChannel !== 'undefined'
    ),
    websocket: typeof WebSocket === 'function',
    fetch: typeof fetch === 'function',
    fileSystemAccess: typeof navigator.storage?.getDirectory === 'function',
    webTransport: typeof WebTransport === 'function',
    networkType: connection?.effectiveType || 'unknown',
    downlinkMbps: Number.isFinite(connection?.downlink) ? connection.downlink : null,
    rttMs: Number.isFinite(connection?.rtt) ? connection.rtt : null,
    saveData: Boolean(connection?.saveData)
  };
}

export function inspectTorrentNetwork(torrent, browser = inspectBrowserNetwork()) {
  const announce = unique(torrent?.announce);
  const protocols = trackerProtocols(announce);
  const wires = Array.isArray(torrent?.wires) ? torrent.wires : [];

  const wireTypes = wires.reduce((acc, wire) => {
    const type = wire?.type || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  const webSeedUrls = unique(torrent?.urlList);
  const connectedPeers = Number(torrent?.numPeers || 0);

  const websocketTrackerAvailable = browser.websocket && (
    protocols.wss > 0 || protocols.ws > 0
  );

  const webSeedAvailable = browser.fetch && webSeedUrls.length > 0;

  let connection;
  let reason;

  if (!browser.online) {
    connection = 'offline';
    reason = 'The browser reports no internet connection.';
  } else if (connectedPeers > 0) {
    connection = 'connected';
    reason = 'At least one torrent wire is connected.';
  } else if (webSeedAvailable) {
    connection = 'possible';
    reason = 'An HTTP(S) web seed is available, but no peer/web-seed wire is connected yet.';
  } else if (websocketTrackerAvailable && browser.webrtc) {
    connection = 'waiting';
    reason = 'WebRTC and WebSocket tracker transport are available; waiting for a compatible peer.';
  } else {
    connection = 'blocked';
    reason = 'No browser-compatible torrent transport is currently available.';
  }

  return {
    connection,
    reason,
    connectedPeers,
    announce,
    protocols,
    webSeedUrls,
    wireTypes,
    hasWebRtcPeer: Boolean(wireTypes.webrtc),
    hasWebSeed: Boolean(wireTypes.webSeed),
    nativeTcpUdpAvailable: Boolean(
      wireTypes.tcpIncoming ||
      wireTypes.tcpOutgoing ||
      wireTypes.utpIncoming ||
      wireTypes.utpOutgoing
    ),
    browser,
    trackerCandidates: WEBTORRENT_TRACKERS
  };
}

export function adapterMatrix(torrent, browser = inspectBrowserNetwork()) {
  const network = inspectTorrentNetwork(torrent, browser);
  return [
    {
      id: 'webrtc-peer',
      name: 'WebRTC peer',
      state: browser.webrtc ? (network.hasWebRtcPeer ? 'connected' : 'available') : 'unavailable',
      detail: browser.webrtc
        ? 'Browser peer-to-peer transport'
        : 'RTCPeerConnection is unavailable'
    },
    {
      id: 'websocket-tracker',
      name: 'WebSocket tracker',
      state: browser.websocket && (network.protocols.wss + network.protocols.ws) > 0 ? 'available' : 'unavailable',
      detail: \`\${network.protocols.wss + network.protocols.ws} WebSocket tracker(s) in metadata\`
    },
    {
      id: 'http-webseed',
      name: 'HTTP(S) web seed',
      state: browser.fetch && network.webSeedUrls.length > 0
        ? (network.hasWebSeed ? 'connected' : 'available')
        : 'unavailable',
      detail: \`\${network.webSeedUrls.length} web seed URL(s)\`
    },
    {
      id: 'webtransport',
      name: 'WebTransport',
      state: browser.webTransport ? 'detected-not-used' : 'unavailable',
      detail: 'Detected by browser, not a WebTorrent transport adapter'
    },
    {
      id: 'tcp-udp',
      name: 'TCP / UDP BitTorrent',
      state: 'native-only',
      detail: 'Requires a native/server gateway; browsers cannot open raw BitTorrent TCP/UDP peers'
    },
    {
      id: 'dht-lsd',
      name: 'DHT / LSD',
      state: 'browser-limited',
      detail: 'Not a raw browser peer transport'
    }
  ];
}
