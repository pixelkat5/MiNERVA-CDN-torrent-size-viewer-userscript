// ==UserScript==
// @name         Minerva Archive CDN Torrent Sizes
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Fetches and parses .torrent files to show content sizes as badges.To sort by file size, click the sort header at the top of the list! https://discord.gg/minerva-archive
// @author       Pixel has heavily modified the script to now use actual file sizes instead of from a json file. Old script from user melumiii on the MiNERVA Discord.
// @match        https://cdn.minerva-archive.org/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const CACHE_PREFIX = 'minerva_v4_';
    const CONCURRENCY  = 5;
    const BADGE_WIDTH  = '85px';

    // Catppuccin Frappe theme::
    function getBadgeColor(bytes) {
        if (bytes === -1) return '#737994'; // Overlay 1
        const GB = 1024 ** 3;
        const TB = 1024 ** 4;
        if (bytes < 1   * GB) return '#a6d189'; // Green
        if (bytes < 10  * GB) return '#e5c890'; // Yellow
        if (bytes < 50  * GB) return '#ef9f76'; // Peach
        if (bytes < 100 * GB) return '#e78284'; // Red
        if (bytes < 500 * GB) return '#ea999c'; // Maroon
        if (bytes < 1   * TB) return '#ca9ee6'; // Mauve
        if (bytes < 10  * TB) return '#85c1dc'; // Sapphire
        return '#99d1db';                       // Sky
    }

    function formatBytes(bytes) {
        if (bytes <= 0) return 'N/A';
        const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        let i = 0, val = bytes;
        while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
        return `${val.toFixed(2)} ${units[i]}`;
    }

    function cacheGet(key) {
        try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + key)); }
        catch { return null; }
    }

    function cacheSet(key, value) {
        try {
            localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                pruneOldest(20);
                try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); } catch {}
            }
        }
    }

    function pruneOldest(count) {
        const entries = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k?.startsWith(CACHE_PREFIX)) continue;
            try {
                const v = JSON.parse(localStorage.getItem(k));
                entries.push({ key: k, cachedAt: v?.cachedAt ?? 0 });
            } catch {
                entries.push({ key: k, cachedAt: 0 });
            }
        }
        entries.sort((a, b) => a.cachedAt - b.cachedAt)
               .slice(0, count)
               .forEach(e => localStorage.removeItem(e.key));
    }

    // Bencode parser. Ints use BigInt to avoid some precision loss on values greater than 2^53 bytes.
    function bdecode(buf, cursor) {
        const b = buf[cursor.pos];
        if (b === 0x69) { cursor.pos++; return bdecodeInt(buf, cursor); }
        if (b === 0x6C) {
            cursor.pos++;
            const list = [];
            while (buf[cursor.pos] !== 0x65) list.push(bdecode(buf, cursor));
            cursor.pos++;
            return list;
        }
        if (b === 0x64) {
            cursor.pos++;
            const dict = {};
            while (buf[cursor.pos] !== 0x65) {
                const key = bdecodeString(buf, cursor);
                dict[key] = bdecode(buf, cursor);
            }
            cursor.pos++;
            return dict;
        }
        if (b >= 0x30 && b <= 0x39) return bdecodeString(buf, cursor);
        throw new Error(`Unexpected bencode byte 0x${b.toString(16)} at pos ${cursor.pos}`);
    }

    function bdecodeInt(buf, cursor) {
        let s = '';
        while (buf[cursor.pos] !== 0x65) s += String.fromCharCode(buf[cursor.pos++]);
        cursor.pos++;
        return BigInt(s);
    }

    function bdecodeString(buf, cursor) {
        let lenStr = '';
        while (buf[cursor.pos] !== 0x3A) lenStr += String.fromCharCode(buf[cursor.pos++]);
        cursor.pos++;
        const len = parseInt(lenStr, 10);
        const slice = buf.subarray(cursor.pos, cursor.pos + len);
        cursor.pos += len;
        return new TextDecoder('latin1').decode(slice);
    }

    function extractTorrentSize(buffer) {
        const torrent = bdecode(new Uint8Array(buffer), { pos: 0 });
        const info = torrent?.info;
        if (!info) return -1;
        if (info.length !== undefined) return Number(info.length);
        if (Array.isArray(info.files)) {
            return Number(info.files.reduce((sum, f) => sum + (f.length !== undefined ? BigInt(f.length) : 0n), 0n));
        }
        return -1;
    }

    async function getSizeForTorrent(href) {
        const filename = decodeURIComponent(href.split('/').pop());
        const cached = cacheGet(filename);

        let lastModified = null;
        try {
            const head = await fetch(href, { method: 'HEAD' });
            lastModified = head.headers.get('Last-Modified') ?? head.headers.get('ETag') ?? null;
        } catch {
            return cached ? { bytes: cached.bytes, readable: cached.readable } : { bytes: -1, readable: 'N/A' };
        }

        if (cached?.lastModified && cached.lastModified === lastModified) {
            return { bytes: cached.bytes, readable: cached.readable };
        }

        try {
            const res = await fetch(href);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const bytes = extractTorrentSize(await res.arrayBuffer());
            const readable = formatBytes(bytes);
            cacheSet(filename, { bytes, readable, lastModified, cachedAt: Date.now() });
            return { bytes, readable };
        } catch (err) {
            console.warn(`[Minerva Sizes] Failed to parse ${filename}:`, err);
            return cached ? { bytes: cached.bytes, readable: cached.readable } : { bytes: -1, readable: 'ERR' };
        }
    }

    function applyBadge(a, tr, bytes, readable) {
        a.previousElementSibling?.classList.contains('tm-size-badge') && a.previousElementSibling.remove();
        tr.dataset.sizeBytes = bytes;
        const badge = document.createElement('span');
        badge.className = 'tm-size-badge';
        const bg = getBadgeColor(bytes);
        const darkBg = bg === '#737994';
        badge.style.cssText = `
            display: inline-block; width: ${BADGE_WIDTH}; text-align: center;
            background-color: ${bg}; color: ${darkBg ? '#c6d0f5' : '#303446'};
            font-size: 0.85em; font-weight: bold; padding: 3px 0;
            border-radius: 12px; margin-right: 12px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            vertical-align: middle; box-sizing: border-box;
        `;
        badge.textContent = readable;
        a.style.verticalAlign = 'middle';
        a.parentNode.insertBefore(badge, a);
    }

    let currentSort = null;

    function hookSizeHeader() {
        const sizeHeader = document.querySelector('th.indexcolsize a');
        if (!sizeHeader) return;
        sizeHeader.addEventListener('click', (e) => {
            e.preventDefault();
            const table = document.querySelector('#indexlist');
            if (!table) return;
            const tbody = table.querySelector('tbody') ?? table;
            const rows = Array.from(tbody.querySelectorAll('tr')).filter(r => r.querySelector('td.indexcolname'));
            if (currentSort !== 'desc') {
                currentSort = 'desc';
                rows.sort((a, b) => Number(b.dataset.sizeBytes ?? -1) - Number(a.dataset.sizeBytes ?? -1));
            } else {
                currentSort = 'asc';
                rows.sort((a, b) => {
                    const sA = Number(a.dataset.sizeBytes ?? -1);
                    const sB = Number(b.dataset.sizeBytes ?? -1);
                    if (sA === -1) return 1;
                    if (sB === -1) return -1;
                    return sA - sB;
                });
            }
            rows.forEach(row => tbody.appendChild(row));
            rows.forEach((row, i) => { row.className = i % 2 === 0 ? 'even' : 'odd'; });
        });
    }

    async function processQueue(tasks, concurrency, fn) {
        let i = 0;
        const worker = async () => { while (i < tasks.length) await fn(tasks[i++]); };
        await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    }

    async function init() {
        const links = Array.from(document.querySelectorAll('td.indexcolname a'))
            .filter(a => a.textContent.trim().endsWith('.torrent'));
        if (!links.length) return;

        hookSizeHeader();

        for (const a of links) {
            const cached = cacheGet(decodeURIComponent(a.href.split('/').pop()));
            const tr = a.closest('tr');
            if (tr) applyBadge(a, tr, cached?.bytes ?? -1, cached?.readable ?? '...');
        }

        await processQueue(links, CONCURRENCY, async (a) => {
            const tr = a.closest('tr');
            if (!tr) return;
            const { bytes, readable } = await getSizeForTorrent(a.href);
            applyBadge(a, tr, bytes, readable);
        });

        console.log(`[Minerva Sizes] ${links.length} torrents sized.`);
    }

    init();
})();
