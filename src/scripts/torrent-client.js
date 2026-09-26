import WebTorrent from './vendor/webtorrent.min.js';

const DB_NAME = 'torrent-downloader';
      const DB_VERSION = 2;
      const STORE = 'torrents';
      const PIECE_STORE = 'pieces';

      let db;
      let client;
      let opfsRoot = null;
      const live = new Map();
      const saveTimers = new Map();

      // Browser WebTorrent can use WebSocket WebTorrent trackers.
      // HTTP/UDP trackers found in ordinary torrent files are not usable
      // directly by a browser client. These are only added to public torrents.
      const WEBTORRENT_TRACKERS = [
        'wss://tracker.webtorrent.dev:443',
        'wss://tracker.openwebtorrent.com:443',
        'wss://open.ftorrent.com:443'
      ];

      const $ = (id) => document.getElementById(id);
      const magnetInput = $('magnet');
      const notice = $('notice');
      const list = $('list');
      const empty = $('empty');
      const count = $('count');

      function showNotice(message) {
        notice.textContent = message;
        notice.style.display = 'block';
      }
      function clearNotice() { notice.style.display = 'none'; }

      function openDb() {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = () => {
            const database = req.result;
            if (!database.objectStoreNames.contains(STORE)) {
              database.createObjectStore(STORE, { keyPath: 'key' });
            }
            if (!database.objectStoreNames.contains(PIECE_STORE)) {
              database.createObjectStore(PIECE_STORE, { keyPath: ['name', 'index'] });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }

      function dbPut(value) {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(value);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      }

      function dbDelete(key) {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(key);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      }

      function dbAll() {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      }

      async function persistStorage() {
        try {
          if (!navigator.storage?.persist) return false;
          return await navigator.storage.persist();
        } catch {
          return false;
        }
      }

      class OPFSChunkStore {
        constructor(chunkLength, opts = {}) {
          this.chunkLength = Number(chunkLength);
          if (!this.chunkLength) throw new Error('Invalid torrent chunk length.');

          this.closed = false;
          this.length = Number(opts.length) || Infinity;
          if (this.length !== Infinity) {
            this.lastChunkLength = this.length % this.chunkLength || this.chunkLength;
            this.lastChunkIndex = Math.ceil(this.length / this.chunkLength) - 1;
          }

          this.name = opts.name || opts.torrent?.infoHash || 'default';
          this.rootDirPromise = opts.rootDir ? Promise.resolve(opts.rootDir) : navigator.storage.getDirectory();
          this.storageDirPromise = this.rootDirPromise.then((root) =>
            root.getDirectoryHandle(this.name, { create: true })
          );
        }

        _closedError() {
          return new Error('Storage is closed');
        }

        async _chunkHandle(index) {
          const dir = await this.storageDirPromise;
          return dir.getFileHandle(String(index), { create: true });
        }

        put(index, buf, cb = () => {}) {
          if (this.closed) return queueMicrotask(() => cb(this._closedError()));

          const expected = index === this.lastChunkIndex
            ? this.lastChunkLength
            : this.chunkLength;

          if (expected && buf.length !== expected) {
            return queueMicrotask(() => cb(new Error(
              (index === this.lastChunkIndex ? 'Last chunk' : 'Chunk') +
              ' length must be ' + expected
            )));
          }

          (async () => {
            try {
              const handle = await this._chunkHandle(index);
              const writable = await handle.createWritable({ keepExistingData: false });
              await writable.write(buf);
              await writable.close();
              cb(null);
            } catch (error) {
              cb(error);
            }
          })();
        }

        get(index, opts, cb = () => {}) {
          if (typeof opts === 'function') return this.get(index, null, opts);
          if (this.closed) return queueMicrotask(() => cb(this._closedError()));

          opts = opts || {};
          const offset = Number(opts.offset || 0);

          (async () => {
            try {
              const handle = await this._chunkHandle(index);
              let file = await handle.getFile();

              const defaultLength = index === this.lastChunkIndex
                ? this.lastChunkLength
                : this.chunkLength;
              const length = opts.length == null
                ? defaultLength - offset
                : Number(opts.length);

              file = file.slice(offset, offset + length);
              const data = await file.arrayBuffer();

              if (data.byteLength === 0) {
                const error = new Error('Index ' + index + ' does not exist');
                error.notFound = true;
                cb(error);
                return;
              }

              cb(null, new Uint8Array(data));
            } catch (error) {
              if (error?.name === 'NotFoundError') {
                error.notFound = true;
              }
              cb(error);
            }
          })();
        }

        close(cb = () => {}) {
          if (this.closed) return queueMicrotask(() => cb(this._closedError()));
          this.closed = true;
          queueMicrotask(() => cb(null));
        }

        destroy(cb = () => {}) {
          if (this.closed) return queueMicrotask(() => cb(this._closedError()));

          (async () => {
            try {
              const root = await this.rootDirPromise;
              await root.removeEntry(this.name, { recursive: true });
              this.closed = true;
              cb(null);
            } catch (error) {
              cb(error);
            }
          })();
        }
      }

      class IDBFallbackChunkStore {
        constructor(chunkLength, opts = {}) {
          this.chunkLength = Number(chunkLength);
          if (!this.chunkLength) throw new Error('Invalid torrent chunk length.');

          this.closed = false;
          this.length = Number(opts.length) || Infinity;
          if (this.length !== Infinity) {
            this.lastChunkLength = this.length % this.chunkLength || this.chunkLength;
            this.lastChunkIndex = Math.ceil(this.length / this.chunkLength) - 1;
          }

          this.name = opts.name || opts.torrent?.infoHash || 'default';
        }

        _error(message) {
          return new Error(message);
        }

        put(index, buf, cb = () => {}) {
          if (this.closed) return queueMicrotask(() => cb(this._error('Storage is closed')));
          const last = index === this.lastChunkIndex;
          const expected = last ? this.lastChunkLength : this.chunkLength;

          if (expected && buf.length !== expected) {
            return queueMicrotask(() => cb(this._error(
              (last ? 'Last chunk' : 'Chunk') + ' length must be ' + expected
            )));
          }

          try {
            const tx = db.transaction(PIECE_STORE, 'readwrite');
            tx.objectStore(PIECE_STORE).put({
              name: this.name,
              index,
              data: new Uint8Array(buf).buffer
            });
            tx.oncomplete = () => cb(null);
            tx.onerror = () => cb(tx.error || this._error('IndexedDB write failed'));
            tx.onabort = () => cb(tx.error || this._error('IndexedDB write aborted'));
          } catch (error) {
            queueMicrotask(() => cb(error));
          }
        }

        get(index, opts, cb = () => {}) {
          if (typeof opts === 'function') return this.get(index, null, opts);
          if (this.closed) return queueMicrotask(() => cb(this._error('Storage is closed')));

          opts = opts || {};
          const offset = Number(opts.offset || 0);

          try {
            const tx = db.transaction(PIECE_STORE, 'readonly');
            const req = tx.objectStore(PIECE_STORE).get([this.name, index]);
            req.onsuccess = () => {
              const record = req.result;
              if (!record?.data) {
                const error = this._error('Index ' + index + ' does not exist');
                error.notFound = true;
                cb(error);
                return;
              }

              let view = new Uint8Array(record.data);
              const length = opts.length == null ? view.byteLength - offset : Number(opts.length);
              view = view.slice(offset, offset + length);
              cb(null, view);
            };
            req.onerror = () => cb(req.error || this._error('IndexedDB read failed'));
          } catch (error) {
            queueMicrotask(() => cb(error));
          }
        }

        close(cb = () => {}) {
          if (this.closed) return queueMicrotask(() => cb(this._error('Storage is closed')));
          this.closed = true;
          queueMicrotask(() => cb(null));
        }

        destroy(cb = () => {}) {
          if (this.closed) return queueMicrotask(() => cb(this._error('Storage is closed')));
          const finish = (error) => {
            if (error) cb(error);
            else {
              this.closed = true;
              cb(null);
            }
          };

          try {
            const tx = db.transaction(PIECE_STORE, 'readwrite');
            const store = tx.objectStore(PIECE_STORE);
            const range = IDBKeyRange.bound([this.name, 0], [this.name, Number.MAX_SAFE_INTEGER]);
            const cursorReq = store.openCursor(range);
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (cursor) {
                cursor.delete();
                cursor.continue();
              }
            };
            cursorReq.onerror = () => finish(cursorReq.error || this._error('IndexedDB cleanup failed'));
            tx.oncomplete = () => finish(null);
            tx.onerror = () => finish(tx.error || this._error('IndexedDB cleanup failed'));
            tx.onabort = () => finish(tx.error || this._error('IndexedDB cleanup aborted'));
          } catch (error) {
            queueMicrotask(() => finish(error));
          }
        }
      }

      function makeStore(chunkLength, storeOpts = {}) {
        if (opfsRoot) return new OPFSChunkStore(chunkLength, { ...storeOpts, rootDir: opfsRoot });
        return new IDBFallbackChunkStore(chunkLength, storeOpts);
      }

      function bitfieldToBytes(bitfield, pieceCount) {
        if (!bitfield || !bitfield.get || !pieceCount) return null;
        const bytes = new Uint8Array(Math.ceil(pieceCount / 8));
        for (let i = 0; i < pieceCount; i++) {
          if (bitfield.get(i)) bytes[i >> 3] |= (1 << (7 - (i & 7)));
        }
        return Array.from(bytes);
      }

      function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        const units = ['B','KB','MB','GB','TB'];
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        return (bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
      }

      function formatRate(bytes) {
        return formatBytes(bytes) + '/s';
      }

      function formatEta(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return '—';
        const sec = Math.round(ms / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h) return h + 'h ' + m + 'm';
        if (m) return m + 'm ' + s + 's';
        return s + 's';
      }

      function cleanName(name) {
        return name || 'Resolving torrent…';
      }

      function stateFor(torrent) {
        if (torrent.done) return 'Completed';
        if (torrent.paused) return 'Paused';
        if (!torrent.ready) return 'Resolving…';
        if (torrent.numPeers === 0) return 'Waiting for peers';
        return 'Downloading';
      }

      function recordFromTorrent(torrent) {
        return {
          key: torrent.infoHash || torrent.magnetURI,
          infoHash: torrent.infoHash || null,
          magnet: torrent.magnetURI,
          name: torrent.name || 'Torrent',
          length: torrent.length || 0,
          progress: torrent.progress || 0,
          downloaded: torrent.downloaded || 0,
          private: Boolean(torrent.private),
          status: stateFor(torrent),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          bitfield: bitfieldToBytes(torrent.bitfield, torrent.pieces?.length) || [],
          files: (torrent.files || []).map((file) => ({ name: file.name, path: file.path, length: file.length }))
        };
      }

      async function saveTorrent(torrent, extra = {}) {
        if (!torrent?.magnetURI) return;
        const key = torrent.infoHash || torrent.magnetURI;
        const old = live.get(key)?.record || {};
        const record = {
          ...old,
          ...recordFromTorrent(torrent),
          ...extra,
          key,
          infoHash: torrent.infoHash || old.infoHash || null,
          magnet: torrent.magnetURI,
          name: torrent.name || old.name || 'Torrent',
          updatedAt: Date.now()
        };
        live.get(key).record = record;
        await dbPut(record);
      }

      function queueSave(torrent) {
        const key = torrent.infoHash || torrent.magnetURI;
        if (saveTimers.has(key)) return;
        saveTimers.set(key, setTimeout(async () => {
          saveTimers.delete(key);
          try {
            await saveTorrent(torrent);
          } catch {}
          render();
        }, 900));
      }

      function torrentInputToRecord(input, label) {
        if (typeof input === 'string') {
          return { magnet: input, label };
        }
        return { magnet: null, label };
      }

      function attachTorrent(torrent, existing = null) {
        const key = existing?.key || torrent.infoHash || torrent.magnetURI;
        live.set(key, {
          torrent,
          record: existing || {
            key,
            magnet: torrent.magnetURI,
            private: Boolean(torrent.private),
            name: torrent.name || 'Resolving torrent…',
            progress: 0,
            downloaded: 0,
            updatedAt: Date.now(),
            files: []
          },
          filesOpen: false
        });

        torrent.on('download', () => {
          queueSave(torrent);
          render();
        });
        torrent.on('done', async () => {
          try { await saveTorrent(torrent, { progress: 1, downloaded: torrent.length, status: 'Completed' }); } catch {}
          render();
        });
        torrent.on('warning', (err) => {
          const message = err?.message || String(err);

          // Optional tracker failures are normal for public tracker pools.
          // Do not replace the entire UI with transient tracker noise.
          if (/tracker|announce/i.test(message)) {
            return;
          }

          showNotice(message);
        });
        torrent.on('error', (err) => {
          const item = live.get(key);
          if (item) item.record.status = 'Error: ' + (err?.message || 'torrent error');
          render();
          showNotice(err?.message || String(err));
        });
        torrent.on('metadata', async () => {
          // Add currently listed WebTorrent-compatible trackers before discovery.
          // Never add public trackers to a private torrent.
          if (!torrent.private) {
            const current = Array.isArray(torrent.announce) ? torrent.announce : [];
            const compatible = current.filter((url) => /^wss?:\/\//i.test(url));
            torrent.announce = [...new Set([...compatible, ...WEBTORRENT_TRACKERS])];
          }

          const newKey = torrent.infoHash || torrent.magnetURI;
          const item = live.get(key);
          if (key !== newKey && item) {
            live.delete(key);
            live.set(newKey, item);
            try { await dbDelete(key); } catch {}
          }
          try { await saveTorrent(torrent); } catch {}
          render();
        });
        torrent.on('ready', async () => {
          try {
            await saveTorrent(torrent);
            if (existing && existing.status !== 'Paused' && !torrent.done) {
              torrent.resume();
            }
            await saveTorrent(torrent);
          } catch (error) {
            showNotice(error?.message || String(error));
          }
          render();
        });
        torrent.on('noPeers', (announceType) => {
          if (announceType === 'tracker') {
            const item = live.get(key);
            if (item && !torrent.done && !torrent.paused) {
              item.record.status = 'Waiting for WebRTC peers';
              render();
            }
          }
        });
        torrent.on('pause', render);
        torrent.on('resume', render);

        return key;
      }

      async function addTorrent(input, existing = null) {
        clearNotice();
        if (!client) throw new Error('Torrent client is not ready.');

        // WebTorrent identifies torrent files and magnets by info hash. Check
        // the active client before creating another Torrent instance so selecting
        // the same .torrent again never creates a temporary duplicate that then
        // destroys/overwrites the visible entry.
        if (!existing) {
          try {
            const active = await client.get(input);
            if (active) {
              const known = [...live.values()].find((item) => item.torrent === active);
              if (!known) {
                attachTorrent(active);
              }
              showNotice('Torrent already added — continuing the existing download.');
              render();
              return active;
            }
          } catch {
            // Let client.add() produce the normal validation error for malformed input.
          }
        }

        const opts = {
          store: makeStore,
          strategy: 'sequential',
          destroyStoreOnDestroy: false
        };

        // Saved torrents start paused until their existing pieces are verified.
        // This prevents a power-loss/reload recovery from racing a fresh download.
        if (existing) {
          opts.paused = true;
          if (existing.bitfield?.length) opts.bitfield = new Uint8Array(existing.bitfield);
        }

        let torrent;
        try {
          torrent = client.add(input, opts);
        } catch (error) {
          showNotice(error.message || String(error));
          return null;
        }

        const key = attachTorrent(torrent, existing);
        saveTorrent(torrent).catch(() => {});
        torrent.on('infoHash', () => {
          if (existing?.key && existing.key !== key) render();
        });
        render();
        return torrent;
      }

      async function addMagnet() {
        const value = magnetInput.value.trim();
        if (!value) return showNotice('Paste a magnet URI first.');
        if (!/^magnet:\?/i.test(value)) return showNotice('That does not look like a magnet URI.');
        if ([...live.values()].some((item) => item.torrent?.magnetURI === value)) {
          magnetInput.value = '';
          return;
        }
        try {
          addTorrent(value);
          magnetInput.value = '';
        } catch (error) {
          showNotice(error.message || String(error));
        }
      }

      async function addTorrentFile(file) {
        if (!file) return;
        clearNotice();
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await addTorrent(bytes);
        } catch (error) {
          showNotice(error.message || String(error));
        }
      }

      async function exportFile(file) {
        try {
          if ('showSaveFilePicker' in window) {
            const handle = await window.showSaveFilePicker({
              suggestedName: file.name,
              types: [{ description: file.type || 'File', accept: { [file.type || 'application/octet-stream']: ['.' + (file.name.split('.').pop() || 'bin')] } }]
            });
            const writable = await handle.createWritable();
            const reader = file.stream().getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await writable.write(value);
              }
            } finally {
              reader.releaseLock();
            }
            await writable.close();
            return;
          }
          const blob = typeof file.blob === 'function'
            ? await file.blob()
            : new Blob([await file.arrayBuffer()], { type: file.type || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = file.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
          if (error?.name !== 'AbortError') showNotice(error.message || String(error));
        }
      }

      async function removeTorrent(key) {
        const item = live.get(key);
        if (!item) return;
        const ok = confirm('Remove this torrent and delete its stored pieces?');
        if (!ok) return;
        try {
          await client.remove(item.torrent, { destroyStore: true });
        } catch {}
        live.delete(key);
        await dbDelete(key);
        render();
      }

      function togglePause(key) {
        const item = live.get(key);
        if (!item) return;
        if (item.torrent.paused) item.torrent.resume();
        else item.torrent.pause();
        saveTorrent(item.torrent).catch(() => {});
        render();
      }

      function toggleFiles(key) {
        const item = live.get(key);
        if (!item) return;
        item.filesOpen = !item.filesOpen;
        render();
      }

      function fileRows(item) {
        if (!item.torrent?.files?.length) return '';
        return item.torrent.files.map((file, i) => {
          const pct = Math.round((file.progress || 0) * 100);
          const id = keyId(item.torrent.infoHash || item.torrent.magnetURI) + '-' + i;
          return '<div class="file-row">' +
            '<div><div class="file-name" title="' + escapeHtml(file.path) + '">' + escapeHtml(file.path) + '</div>' +
            '<div class="file-size">' + formatBytes(file.length) + ' · ' + pct + '%</div></div>' +
            '<button class="secondary" data-export="' + encodeAttr(id) + '">Save</button>' +
          '</div>';
        }).join('');
      }

      const exportLookup = new Map();

      function keyId(value) {
        return btoa(unescape(encodeURIComponent(value))).replace(/[^a-z0-9]/gi, '').slice(0, 24);
      }

      function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      }

      function encodeAttr(value) { return encodeURIComponent(value); }

      function render() {
        exportLookup.clear();
        const items = [...live.entries()];
        count.textContent = items.length + (items.length === 1 ? ' item' : ' items');
        empty.classList.toggle('hidden', items.length > 0);

        for (const [, item] of items) {
          const torrent = item.torrent;
          const key = torrent.infoHash || torrent.magnetURI || item.record.key;
          const pct = Math.max(0, Math.min(100, (torrent.progress || item.record.progress || 0) * 100));
          const state = stateFor(torrent);
          const canPause = !torrent.done;
          const fileKey = keyId(key);
          (torrent.files || []).forEach((file, index) => exportLookup.set(fileKey + '-' + index, file));

          let card = document.querySelector('[data-key="' + CSS.escape(key) + '"]');
          if (!card) {
            card = document.createElement('article');
            card.className = 'card';
            card.dataset.key = key;
            list.appendChild(card);
          }

          card.innerHTML =
            '<div class="top">' +
              '<div><div class="name">' + escapeHtml(cleanName(torrent.name || item.record.name)) + '</div>' +
              '<div class="meta">' + escapeHtml(state) + (torrent.infoHash ? ' · ' + escapeHtml(torrent.infoHash.slice(0, 12)) : '') + '</div></div>' +
              '<div class="actions">' +
                '<button class="ghost" data-files="' + encodeAttr(key) + '">' + (item.filesOpen ? 'Hide files' : 'Files') + '</button>' +
                (canPause ? '<button class="secondary" data-pause="' + encodeAttr(key) + '">' + (torrent.paused ? 'Resume' : 'Pause') + '</button>' : '') +
                '<button class="danger" data-remove="' + encodeAttr(key) + '">Remove</button>' +
              '</div>' +
            '</div>' +
            '<div class="bar-wrap"><div class="bar" style="width:' + pct.toFixed(2) + '%"></div></div>' +
            '<div class="stats">' +
              '<div class="stat"><small>Progress</small><b>' + pct.toFixed(1) + '%</b></div>' +
              '<div class="stat"><small>Downloaded</small><b>' + formatBytes(torrent.downloaded || 0) + '</b></div>' +
              '<div class="stat"><small>Speed</small><b>' + formatRate(torrent.downloadSpeed || 0) + '</b></div>' +
              '<div class="stat"><small>Peers</small><b>' + (torrent.numPeers || 0) + '</b></div>' +
              '<div class="stat"><small>ETA</small><b>' + (torrent.done ? 'Done' : formatEta(torrent.timeRemaining)) + '</b></div>' +
            '</div>' +
            '<div class="files ' + (item.filesOpen ? 'open' : '') + '">' + fileRows(item) + '</div>';

          card.querySelector('[data-files]')?.addEventListener('click', () => toggleFiles(key));
          card.querySelector('[data-pause]')?.addEventListener('click', () => togglePause(key));
          card.querySelector('[data-remove]')?.addEventListener('click', () => removeTorrent(key));
          card.querySelectorAll('[data-export]').forEach((button) => {
            button.addEventListener('click', () => {
              const file = exportLookup.get(decodeURIComponent(button.dataset.export));
              if (file) exportFile(file);
            });
          });
        }

        const keep = new Set(items.map(([key]) => key));
        list.querySelectorAll('.card[data-key]').forEach((node) => {
          if (!keep.has(node.dataset.key)) node.remove();
        });
      }

      async function boot() {
        try {
          db = await openDb();
          if (navigator.storage?.getDirectory) {
            try {
              opfsRoot = await navigator.storage.getDirectory();
            } catch {
              opfsRoot = null;
            }
          }
          const persisted = await persistStorage();
          $('storageDot').classList.remove('warn');
          $('storageText').textContent = persisted
            ? (opfsRoot ? 'Persistent storage enabled · OPFS torrent pieces' : 'Persistent storage enabled · IndexedDB fallback')
            : (opfsRoot ? 'Browser storage available · OPFS pieces' : 'Browser storage available · persistence not guaranteed');
        } catch (error) {
          $('storageText').textContent = 'Browser storage unavailable';
          showNotice('IndexedDB is unavailable, so resumable downloads cannot be guaranteed. ' + (error?.message || ''));
          return;
        }

        if (typeof WebTorrent !== 'function') {
          $('storageText').textContent = 'WebTorrent failed to load';
          showNotice('The bundled WebTorrent client is unavailable. Reload after the latest deployment.');
          return;
        }

        client = new WebTorrent();
        client.on('error', (error) => showNotice(error?.message || String(error)));

        const saved = db ? await dbAll() : [];
        for (const record of saved) {
          if (!record.magnet) continue;
          try {
            await addTorrent(record.magnet, record);
          } catch { }
        }
        render();
      }

      $('addMagnet').addEventListener('click', addMagnet);
      magnetInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') addMagnet();
      });
      $('torrentFile').addEventListener('change', (event) => {
        addTorrentFile(event.target.files?.[0]);
        event.target.value = '';
      });

      window.addEventListener('pagehide', () => {
        // Save torrent state before the page is hidden.
        // Do NOT destroy the client here — destroying it synchronously would
        // cancel the async IndexedDB writes before they complete.
        try {
          for (const item of live.values()) {
            if (item.torrent?.infoHash) saveTorrent(item.torrent).catch(() => {});
          }
        } catch {}
      });

      window.addEventListener('beforeunload', () => {
        // Attempt a synchronous final save on unload.
        try {
          for (const item of live.values()) {
            if (item.torrent?.infoHash) saveTorrent(item.torrent).catch(() => {});
          }
        } catch {}
      });

      boot();