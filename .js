// ==UserScript==
// @name         Vizier Skid v18.0.2 (auto-move)
// @namespace    vizier-skid
// @version      18.0.2
// @description  Auto-move + scan + arrow. Vizier (d22) or Stockfish (d15). V = scan, X = clear, M = minimize.
// @match        *://*.chess.com/*
// @match        *://chess.com/*
// @match        *://*.lichess.org/*
// @match        *://lichess.org/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      cdn.jsdelivr.net
// @connect      lichess1.org
// @connect      *
// ==/UserScript==

/* Vizier Skid v18.0.2 (auto-move)
 *
 * v18.0.1 → v18.0.2:
 *   + Auto-move toggle — after scan returns, simulates a real mouse drag
 *     on the source piece → target square (mousedown → mousemove path →
 *     mouseup, plus pointer events). The site's own piece handlers fire
 *     and the move actually plays.
 *   + Anti-loop: after auto-move fires, observer is debounced so our own
 *     piece-movement doesn't re-trigger a scan. Resets on opponent move.
 *   + Status surfaces 'moving e2e4…' during the drag.
 *
 * WARNING: auto-move plays moves for you. If you use it on chess.com with
 * the rules off, you'll get banned. Use an alt or in casual / unrated.
 */

/* v18.0.1 bug-burn list (carried over):
 *
 * Bug-burn list (v3 → v18):
 *   ✘ Mate-probe (go mate 5) returned bestmove 0000 on no-mate, my code
 *      rejected it and the stale bestmove poisoned the next scan.
 *      FIX: dropped the mate probe entirely. Vizier now = depth 22,
 *           Stockfish = depth 15. Mates surface naturally from info lines.
 *   ✘ Stale bestmove from previous scan resolved the new scan's promise
 *      with the old move = phantom arrow.
 *      FIX: discard-next-bestmove flag set on every new scan start;
 *           per-scan ID stamp; the stop-induced bestmove is always thrown away.
 *   ✘ V key not firing — chess.com / lichess capture keydown before document.
 *      FIX: window-level listener with capture=true. fires before the site.
 *   ✘ Flipped board misdetected via piece-count heuristic sometimes.
 *      FIX: prefer the page's own orientation class first
 *           (.orientation-black / .board-flipped); heuristic is last resort.
 *   ✘ No feedback when engine was still loading.
 *      FIX: scan() blocks if engine not ready, triggers lazy load, surfaces
 *           every state in the panel status line + footer scan-ID counter.
 */

(function () {
  'use strict';

  const LOG = (...a) => console.log('%c[vizier v18]', 'color:#00FF87;font-weight:bold', ...a);
  const ERR = (...a) => console.error('%c[vizier v18]', 'color:#F87171;font-weight:bold', ...a);
  LOG('loaded. if you see old versions in tampermonkey, delete them. press V to scan.');

  // ===========================================================================
  // Engine state — single in-flight scan, no race
  // ===========================================================================
  let sf = null;
  let sfReady = false;
  let sfLoading = false;
  let sfQueue = [];
  let sfSource = '—';
  let scanCounter = 0;            // increments on every scan start
  let pendingScan = null;         // { id, resolve, reject, via, timer }
  let discardNextBestmove = false; // true while we wait for stop-induced bestmove
  let lastInfo = null;            // last {cp|x,mate} from info line

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'text',
        onload: (r) => resolve(r.responseText),
        onerror: (e) => reject(e),
        ontimeout: () => reject(new Error('timeout ' + url)),
      });
    });
  }

  function patchLocateFile(src, baseUrl) {
    const dir = baseUrl.replace(/\/[^/]*$/, '/');
    return src.replace(
      /locateFile\s*[:=]\s*function\s*\([^)]*\)\s*\{[^}]*\}/g,
      `locateFile:function(p){return ${JSON.stringify(dir)}+p;}`
    );
  }

  async function loadEngine(onStatus) {
    if (sfLoading) return sfReady;
    sfLoading = true;
    const sources = [
      ['sf16 nnue single', 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.js'],
      ['sf15',              'https://cdn.jsdelivr.net/npm/stockfish@15/src/stockfish.js'],
      ['sf10 asm.js',      'https://cdn.jsdelivr.net/npm/stockfish@10.0.2/stockfish.js'],
    ];
    for (const [label, url] of sources) {
      onStatus && onStatus(`loading ${label}…`);
      try {
        LOG('fetching', url);
        const code = await gmFetch(url);
        const patched = patchLocateFile(code, url);
        const blob = new Blob([patched], { type: 'application/javascript' });
        const w = new Worker(URL.createObjectURL(blob));
        w.onmessage = (e) => handleSfLine(e.data);
        w.onerror = (e) => {
          ERR('worker error:', e.message || e, '— flagging for reload');
          sfReady = false; sf = null;
        };
        w.postMessage('uci');
        sf = w;
        if (await waitReady(7000)) {
          sfSource = label;
          sfLoading = false;
          LOG('engine ready:', label);
          return true;
        }
        try { w.terminate(); } catch (_) {}
        sf = null;
      } catch (e) {
        ERR('source failed', url, e.message || e);
      }
    }
    sfLoading = false;
    return false;
  }

  function waitReady(ms) {
    return new Promise((res) => {
      const start = Date.now();
      const c = () => {
        if (sfReady) return res(true);
        if (Date.now() - start > ms) return res(false);
        setTimeout(c, 100);
      };
      c();
    });
  }

  function handleSfLine(line) {
    if (typeof line !== 'string') return;
    if (line === 'uciok') {
      sfReady = true;
      while (sfQueue.length) { try { sf.postMessage(sfQueue.shift()); } catch (_) {} }
    }
    if (line.startsWith('info') && line.includes(' pv ')) {
      const m = line.match(/score (cp|mate) (-?\d+)/);
      if (m) {
        if (m[1] === 'mate') lastInfo = { mate: parseInt(m[2], 10) };
        else lastInfo = { cp: parseInt(m[2], 10) };
      }
    }
    if (line.startsWith('bestmove')) {
      // If we just sent 'stop' to cancel a previous search, the first
      // bestmove to arrive belongs to that cancelled search — discard it.
      if (discardNextBestmove) {
        discardNextBestmove = false;
        LOG('discarding stop-induced bestmove');
        return;
      }
      if (!pendingScan) {
        LOG('orphan bestmove (no pending scan) — ignored');
        return;
      }
      const r = pendingScan;
      const m = line.match(/bestmove\s+(\S+)/);
      const move = m ? m[1] : null;
      if (!move || move === '(none)' || move === '0000') {
        clearTimeout(r.timer);
        pendingScan = null;
        r.reject(new Error('no legal move'));
        return;
      }
      let evalText = '?';
      if (lastInfo) {
        if ('mate' in lastInfo) evalText = 'M' + lastInfo.mate;
        else {
          const cp = lastInfo.cp;
          evalText = (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
        }
      }
      clearTimeout(r.timer);
      pendingScan = null;
      r.resolve({ move, eval: evalText, via: r.via });
    }
  }

  function sfCmd(c) {
    if (!sf) return;
    if (sfReady) { try { sf.postMessage(c); } catch (_) {} }
    else sfQueue.push(c);
  }

  // Single entry for any engine ask. Aborts any in-flight scan cleanly.
  function askEngine(fen, opts) {
    return new Promise((resolve, reject) => {
      // Abort any pending scan first
      if (pendingScan) {
        try { sfCmd('stop'); } catch (_) {}
        clearTimeout(pendingScan.timer);
        const old = pendingScan;
        pendingScan = null;
        old.reject(new Error('superseded'));
        // the stop's bestmove will arrive next — discard it
        discardNextBestmove = true;
      }
      const id = ++scanCounter;
      lastInfo = null;
      pendingScan = {
        id, resolve, reject, via: opts.via,
        timer: setTimeout(() => {
          if (pendingScan && pendingScan.id === id) {
            try { sfCmd('quit'); } catch (_) {}
            try { sf && sf.terminate(); } catch (_) {}
            sf = null; sfReady = false;
            pendingScan = null;
            reject(new Error('engine timeout (' + opts.timeoutMs + 'ms) — worker reloaded on next scan'));
          }
        }, opts.timeoutMs),
      };
      // tiny delay so any stop's bestmove lands before we send our 'go'
      setTimeout(() => {
        if (!pendingScan || pendingScan.id !== id) return;
        sfCmd('ucinewgame');
        sfCmd('position fen ' + fen);
        sfCmd('go depth ' + opts.depth);
      }, 80);
    });
  }

  async function askVizier(fen, depth) {
    return askEngine(fen, { depth: Math.max(depth || 15, 22), timeoutMs: 12000, via: 'vizier' });
  }
  async function askStockfish(fen, depth) {
    return askEngine(fen, { depth: depth || 15, timeoutMs: 8000, via: 'stockfish' });
  }

  // ===========================================================================
  // Board readers
  // ===========================================================================
  const isLichess = () => location.hostname.includes('lichess.org');
  const isChessCom = () => location.hostname.includes('chess.com');

  const PIECE_CLASS = {
    wp:'P', wr:'R', wn:'N', wb:'B', wq:'Q', wk:'K',
    bp:'p', br:'r', bn:'n', bb:'b', bq:'q', bk:'k',
  };

  function detectFlippedLichess() {
    // explicit orientation first
    const mainBoard = document.querySelector('.main-board');
    if (mainBoard && mainBoard.classList.contains('orientation-black')) return true;
    if (mainBoard && mainBoard.classList.contains('orientation-white')) return false;
    // chessground container flip class
    const wrapper = document.querySelector('div.cg-board-wrap');
    if (wrapper && wrapper.classList.contains('flip')) return true;
    return null; // unknown — fall back to heuristic
  }
  function detectFlippedChessCom() {
    const board = document.querySelector('chess-board') || document.querySelector('.board');
    if (board && board.classList.contains('board-flipped')) return true;
    if (board && board.classList.contains('flipped')) return true;
    // chess.com sometimes puts flipped on a parent
    if (document.querySelector('.board.board-flipped, .board.flipped')) return true;
    return null;
  }

  function readLichess() {
    const board = document.querySelector('cg-board') || document.querySelector('.cg-board');
    if (!board) return null;
    const pieces = board.querySelectorAll('piece');
    if (!pieces.length) return null;
    const rect = board.getBoundingClientRect();
    if (rect.width < 100) return null;
    const sqSize = rect.width / 8;

    let flipped = detectFlippedLichess();
    if (flipped === null) flipped = false; // default, refine via heuristic below

    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    pieces.forEach(p => {
      let piece = null;
      p.classList.forEach(c => { if (PIECE_CLASS[c]) piece = PIECE_CLASS[c]; });
      if (!piece) {
        const dp = p.getAttribute('data-piece');
        if (dp) piece = dp;
      }
      if (!piece) return;
      let x = 0, y = 0;
      const tr = p.style.transform || '';
      let m = tr.match(/translate(?:3d)?\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px/);
      if (m) { x = parseFloat(m[1]); y = parseFloat(m[2]); }
      else {
        m = tr.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([-\d.]+),\s*([-\d.]+)\)/);
        if (m) { x = parseFloat(m[1]); y = parseFloat(m[2]); }
      }
      const col = Math.round(x / sqSize);
      const row = Math.round(y / sqSize);
      if (col < 0 || col > 7 || row < 0 || row > 7) return;
      grid[row][col] = { piece };
    });

    // heuristic fallback only if explicit class didn't fire
    if (detectFlippedLichess() === null) {
      let whiteTop = 0, whiteBottom = 0;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const cell = grid[r][c];
        if (!cell) continue;
        if (cell.piece === cell.piece.toUpperCase()) {
          if (r < 4) whiteTop++; else whiteBottom++;
        }
      }
      if (whiteTop > whiteBottom) flipped = true;
    }
    return { board, grid, sqSize, flipped, rect };
  }

  function readChessCom() {
    const board = document.querySelector('chess-board') || document.querySelector('.board');
    if (!board) return null;
    const pieces = board.querySelectorAll('.piece');
    if (!pieces.length) return null;
    const rect = board.getBoundingClientRect();
    if (rect.width < 100) return null;
    const sqSize = rect.width / 8;
    let flipped = detectFlippedChessCom() === true;

    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    pieces.forEach(p => {
      let piece = null, file = null, rank = null;
      p.classList.forEach(c => {
        if (PIECE_CLASS[c]) piece = PIECE_CLASS[c];
        const sm = c.match(/^square-(\d)(\d)$/);
        if (sm) { file = parseInt(sm[1]); rank = parseInt(sm[2]); }
      });
      if (!piece) return;
      let col, row;
      if (file !== null && rank !== null) {
        col = flipped ? 8 - file : file - 1;
        row = flipped ? rank - 1 : 8 - rank;
      } else {
        const tr = p.style.transform || '';
        const m = tr.match(/translate\(\s*([-\d.]+)px[^,]*,\s*([-\d.]+)px/);
        if (!m) return;
        col = Math.round(parseFloat(m[1]) / sqSize);
        row = Math.round(parseFloat(m[2]) / sqSize);
      }
      if (col < 0 || col > 7 || row < 0 || row > 7) return;
      grid[row][col] = { piece };
    });
    return { board, grid, sqSize, flipped, rect };
  }

  function countKings(grid) {
    let wK = 0, bK = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const cell = grid[r][c];
      if (!cell) continue;
      if (cell.piece === 'K') wK++;
      if (cell.piece === 'k') bK++;
    }
    return { wK, bK };
  }

  // detect castling rights from piece placement
  function detectCastling(grid, flipped) {
    let wKq = '', wKk = '', bKq = '', bKk = '';
    const wkRow = flipped ? 0 : 7;
    const bkRow = flipped ? 7 : 0;
    if (grid[wkRow][4]?.piece === 'K') {
      if (grid[wkRow][0]?.piece === 'R') wKq = 'Q';
      if (grid[wkRow][7]?.piece === 'R') wKk = 'K';
    }
    if (grid[bkRow][4]?.piece === 'k') {
      if (grid[bkRow][0]?.piece === 'r') bKq = 'q';
      if (grid[bkRow][7]?.piece === 'r') bKk = 'k';
    }
    return (wKq + wKk + bKq + bKk) || '-';
  }

  function gridToFen(grid, flipped, turn) {
    const rows = [];
    for (let r = 0; r < 8; r++) {
      let row = '', empty = 0;
      for (let c = 0; c < 8; c++) {
        const cell = grid[r][flipped ? 7 - c : c];
        if (!cell) empty++;
        else {
          if (empty > 0) { row += empty; empty = 0; }
          row += cell.piece;
        }
      }
      if (empty > 0) row += empty;
      rows.push(row);
    }
    const castle = detectCastling(grid, flipped);
    return rows.join('/') + ' ' + turn + ' ' + castle + ' - 0 1';
  }

  // ===========================================================================
  // Arrow + badge
  // ===========================================================================
  let arrowEl = null, badgeEl = null;
  function clearOverlay() {
    if (arrowEl) { arrowEl.remove(); arrowEl = null; }
    if (badgeEl) { badgeEl.remove(); badgeEl = null; }
  }
  function drawArrow(state, from, to, evalText, via) {
    clearOverlay();
    const { board, sqSize, flipped, rect } = state;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', rect.width);
    svg.setAttribute('height', rect.height);
    svg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:9999;';
    if (getComputedStyle(board).position === 'static') board.style.position = 'relative';
    board.appendChild(svg);
    function center(name) {
      const file = name.charCodeAt(0) - 97;
      const rank = parseInt(name[1]);
      const col = flipped ? 7 - file : file;
      const row = flipped ? rank - 1 : 8 - rank;
      return [col * sqSize + sqSize / 2, row * sqSize + sqSize / 2];
    }
    const [x1, y1] = center(from);
    const [x2, y2] = center(to);
    const dx = x2 - x1, dy = y2 - y1;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;
    const x2s = x2 - ux * (sqSize * 0.22);
    const y2s = y2 - uy * (sqSize * 0.22);
    const color = via === 'vizier' ? '#00FF87' : '#22D3EE';

    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2s); line.setAttribute('y2', y2s);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(Math.max(5, sqSize / 12)));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('opacity', '0.9');
    svg.appendChild(line);

    const head = document.createElementNS(svgNS, 'polygon');
    const ah = Math.max(14, sqSize / 4);
    const ang = Math.atan2(dy, dx);
    const p1 = [x2s, y2s];
    const p2 = [x2s - ah * Math.cos(ang - Math.PI/6), y2s - ah * Math.sin(ang - Math.PI/6)];
    const p3 = [x2s - ah * Math.cos(ang + Math.PI/6), y2s - ah * Math.sin(ang + Math.PI/6)];
    head.setAttribute('points', [p1,p2,p3].map(p=>p.map(v=>v.toFixed(1)).join(',')).join(' '));
    head.setAttribute('fill', color);
    svg.appendChild(head);

    const ring = document.createElementNS(svgNS, 'circle');
    ring.setAttribute('cx', x2); ring.setAttribute('cy', y2);
    ring.setAttribute('r', String(sqSize / 2.5));
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', color);
    ring.setAttribute('stroke-width', '3');
    svg.appendChild(ring);
    arrowEl = svg;

    const badge = document.createElement('div');
    badge.style.cssText =
      'position:absolute;top:8px;left:8px;background:rgba(0,0,0,0.85);' +
      `color:${color};padding:6px 10px;font:600 12px Consolas,monospace;` +
      `border:1px solid ${color};border-radius:4px;z-index:10000;pointer-events:none;`;
    const tag = via === 'vizier' ? 'vizier' : 'sf';
    badge.textContent = `${tag} → ${from}${to}  eval ${evalText || '?'}`;
    board.appendChild(badge);
    badgeEl = badge;
  }

  // ===========================================================================
  // Auto-move — simulate a real drag on the board
  // ===========================================================================
  async function makeMove(state, from, to, opts = {}) {
    const { rect, sqSize, flipped } = state;
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    function center(name) {
      const file = name.charCodeAt(0) - 97;
      const rank = parseInt(name[1]);
      const col = flipped ? 7 - file : file;
      const row = flipped ? rank - 1 : 8 - rank;
      return {
        clientX: rect.left + col * sqSize + sqSize / 2,
        clientY: rect.top + row * sqSize + sqSize / 2,
      };
    }
    const src = center(from);
    const dst = center(to);

    const sourceEl = document.elementFromPoint(src.clientX, src.clientY);
    if (!sourceEl) return { ok: false, error: 'no element at source square' };

    function fire(type, coords, el) {
      const target = el || document.elementFromPoint(coords.clientX, coords.clientY) || sourceEl;
      const init = {
        bubbles: true, cancelable: true, view: window,
        button: 0, buttons: (type.endsWith('move')) ? 1 : 0,
        clientX: coords.clientX, clientY: coords.clientY,
        screenX: coords.clientX, screenY: coords.clientY,
        pageX: coords.clientX, pageY: coords.clientY,
        relatedTarget: null,
      };
      try { target.dispatchEvent(new MouseEvent(type, init)); } catch (_) {}
      try {
        const pe = new PointerEvent('pointer' + type, Object.assign({}, init, {
          pointerId: 1, pointerType: 'mouse', isPrimary: true,
        }));
        target.dispatchEvent(pe);
      } catch (_) {}
    }

    // pick up
    fire('mousedown', src, sourceEl);
    await delay(opts.pickDelay || 60);

    // drag path
    const steps = opts.steps || 12;
    const moveDelay = opts.moveDelay || 25;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const c = {
        clientX: src.clientX + (dst.clientX - src.clientX) * t,
        clientY: src.clientY + (dst.clientY - src.clientY) * t,
      };
      fire('mousemove', c);
      await delay(moveDelay);
    }
    // brief dwell at target
    await delay(opts.dropDelay || 80);
    fire('mouseup', dst);
    return { ok: true };
  }

  // ===========================================================================
  // Panel
  // ===========================================================================
  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'vizier-panel-host-v18';
    host.style.cssText = 'position:fixed;top:80px;right:24px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
        :host { all: initial; }
        #panel {
          width: 280px; background: #0E1116; border: 1px solid #2A2F3A;
          border-radius: 10px; color: #E5E7EB; font-size: 13px; overflow: hidden;
          box-shadow: 0 16px 40px rgba(0,0,0,.55); user-select: none;
        }
        header {
          background: linear-gradient(180deg, #1A1F2B 0%, #161B22 100%);
          padding: 10px 14px; display: flex; align-items: center; gap: 8px;
          cursor: move; border-bottom: 1px solid #2A2F3A;
        }
        .logo { color: #00FF87; font-weight: 700; font-size: 13px; letter-spacing: 1.5px; }
        .tag {
          color: #6B7280; font-family: Consolas,monospace; font-size: 9px;
          background: #0E1116; padding: 2px 5px; border-radius: 3px;
          border: 1px solid #2A2F3A;
        }
        .min {
          margin-left: auto; cursor: pointer; color: #6B7280; font-size: 14px;
          width: 18px; text-align: center; line-height: 1;
        }
        .min:hover { color: #E5E7EB; }
        .body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
        .status {
          background: #161B22; border-radius: 4px; padding: 8px 10px;
          font-family: Consolas,monospace; font-size: 11px; color: #9CA3AF;
          min-height: 40px; line-height: 1.5; word-break: break-all;
        }
        .status .move { color: #00FF87; font-weight: 700; font-size: 12px; }
        .status .eval { color: #22D3EE; font-weight: 700; }
        .status .err { color: #F87171; }
        .row { display: flex; gap: 6px; }
        button {
          flex: 1; padding: 8px; border: 0; border-radius: 4px;
          font-size: 11px; font-weight: 700; cursor: pointer;
          background: #1F2630; color: #E5E7EB; transition: background .12s;
        }
        button:hover:not(:disabled) { background: #2A323D; }
        button:disabled { opacity: 0.55; cursor: default; }
        button.primary { background: #00FF87; color: #0E1116; letter-spacing: 0.5px; }
        button.primary:hover:not(:disabled) { background: #22FF99; }
        label {
          display: flex; align-items: center; justify-content: space-between;
          color: #9CA3AF; font-size: 11px; gap: 8px;
        }
        label span:first-child { min-width: 80px; }
        input[type=range] { flex: 1; accent-color: #00FF87; height: 4px; }
        .seg {
          flex: 1; display: flex; border-radius: 4px; overflow: hidden;
          border: 1px solid #2A2F3A;
        }
        .seg button { border-radius: 0; flex: 1; }
        .seg button.active { background: #00FF87; color: #0E1116; }
        .seg button.active.vizier { background: #00FF87; color: #0E1116; }
        .seg button.active.stockfish { background: #22D3EE; color: #0E1116; }
        .footer {
          padding: 6px 12px; border-top: 1px solid #2A2F3A;
          font-family: Consolas,monospace; font-size: 9px; color: #6B7280;
          display: flex; justify-content: space-between;
        }
        .collapsed .body, .collapsed .footer { display: none; }
        .hint { font-size: 9px; color: #6B7280; line-height: 1.4; }
      </style>
      <div id="panel">
        <header id="header">
          <span class="logo"><span class="diamond">◆</span> VIZIER</span>
          <span class="tag">v18.0.1</span>
          <span class="min" id="min" title="minimize">–</span>
        </header>
        <div class="body">
          <div class="status" id="status">booting engine…</div>
          <div class="row">
            <button class="primary" id="scan">SCAN</button>
            <button id="clear">Clear</button>
          </div>
          <div>
            <label><span>Engine</span></label>
            <div class="seg" id="engineSeg" style="margin-top:4px;">
              <button data-engine="vizier" class="active vizier">Vizier (d22)</button>
              <button data-engine="stockfish" class="stockfish">Stockfish (d15)</button>
            </div>
          </div>
          <label>
            <span>Depth <b id="depthVal" style="color:#00FF87">15</b></span>
            <input type="range" id="depth" min="6" max="22" value="15">
          </label>
          <label>
            <span>Turn</span>
            <div class="seg" id="turnSeg">
              <button data-turn="w" class="active">White</button>
              <button data-turn="b">Black</button>
            </div>
          </label>
          <label>
            <span>Auto-scan</span>
            <div class="seg" id="autoSeg">
              <button data-auto="off" class="active">Off</button>
              <button data-auto="on">On</button>
            </div>
          </label>
          <label>
            <span style="color:#F87171">Auto-move</span>
            <div class="seg" id="moveSeg">
              <button data-move="off" class="active">Off</button>
              <button data-move="on">On</button>
            </div>
          </label>
          <div class="hint" style="color:#F87171">WARNING: auto-move plays moves for you. Use an alt or unrated games only.</div>
        </div>
        <div class="footer">
          <span id="engineInfo">engine: —</span>
          <span id="scanInfo">scans: 0</span>
        </div>
      </div>
    `;
    document.documentElement.appendChild(host);

    const $ = (id) => shadow.getElementById(id);
    const statusEl = $('status');
    const engineEl = $('engineInfo');
    const scanInfoEl = $('scanInfo');
    const scanBtn = $('scan');
    const depthInput = $('depth');
    const depthVal = $('depthVal');

    const ui = { depth: 15, turn: 'w', auto: false, autoMove: false, engine: 'vizier' };

    function setStatus(html, kind = '') {
      const cls = kind ? ` class="${kind}"` : '';
      statusEl.innerHTML = `<span${cls}>${html}</span>`;
    }
    function setEngine(s) { engineEl.textContent = 'engine: ' + s; }
    function setScanning(b) {
      scanBtn.textContent = b ? '…' : 'SCAN';
      scanBtn.disabled = b;
    }
    function setScanCount(n) { scanInfoEl.textContent = 'scans: ' + n; }

    // drag
    const header = $('header');
    const panel = $('panel');
    let dragging = false, ox = 0, oy = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.id === 'min') return;
      dragging = true;
      const rect = host.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      host.style.left = Math.max(0, e.clientX - ox) + 'px';
      host.style.top = Math.max(0, e.clientY - oy) + 'px';
      host.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    $('min').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      $('min').textContent = panel.classList.contains('collapsed') ? '+' : '–';
    });

    depthInput.addEventListener('input', () => {
      ui.depth = parseInt(depthInput.value);
      depthVal.textContent = ui.depth;
    });

    shadow.querySelectorAll('#turnSeg button').forEach(b => {
      b.addEventListener('click', () => {
        shadow.querySelectorAll('#turnSeg button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        ui.turn = b.dataset.turn;
      });
    });
    shadow.querySelectorAll('#autoSeg button').forEach(b => {
      b.addEventListener('click', () => {
        shadow.querySelectorAll('#autoSeg button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        ui.auto = (b.dataset.auto === 'on');
      });
    });
    shadow.querySelectorAll('#moveSeg button').forEach(b => {
      b.addEventListener('click', () => {
        shadow.querySelectorAll('#moveSeg button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        ui.autoMove = (b.dataset.move === 'on');
        if (ui.autoMove && !ui.auto) {
          // turn on auto-scan too so it loops
          shadow.querySelectorAll('#autoSeg button').forEach(x => x.classList.remove('active'));
          shadow.querySelector('#autoSeg button[data-auto="on"]').classList.add('active');
          ui.auto = true;
        }
      });
    });
    shadow.querySelectorAll('#engineSeg button').forEach(b => {
      b.addEventListener('click', () => {
        shadow.querySelectorAll('#engineSeg button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        ui.engine = b.dataset.engine;
        setStatus(`engine: <b>${ui.engine}</b> · press V or SCAN`);
      });
    });

    scanBtn.addEventListener('click', (e) => { e.preventDefault(); scan(); });
    $('clear').addEventListener('click', () => { clearOverlay(); setStatus('cleared'); });

    return {
      ui,
      setStatus, setEngine, setScanning, setScanCount,
      collapsed: () => panel.classList.contains('collapsed'),
      toggleCollapse: () => {
        panel.classList.toggle('collapsed');
        $('min').textContent = panel.classList.contains('collapsed') ? '+' : '–';
      },
    };
  }

  // ===========================================================================
  // Scan
  // ===========================================================================
  let scanning = false;
  let panel = null;
  let autoObserver = null;
  let lastScanAt = 0;
  let lastFingerprint = '';

  function boardFingerprint(state) {
    let s = state.flipped ? '1' : '0';
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      s += (state.grid[r][c]?.piece || '.');
    }
    return s;
  }

  async function scan() {
    LOG('scan() called — scanning=' + scanning);
    if (scanning) { panel.setStatus('still scanning — press <b>X</b> to abort'); return; }
    if (!panel) { LOG('no panel — bailing'); return; }
    // Lazy-load engine if needed
    if (!sfReady && !sfLoading) {
      panel.setStatus('engine not loaded — lazy-loading now…');
      const ok = await loadEngine((s) => panel.setStatus(s));
      if (!ok) { panel.setStatus('FAILED — no engine source loaded. check console.', 'err'); return; }
      panel.setEngine(sfSource);
    } else if (sfLoading) {
      panel.setStatus('engine still loading — wait a moment, then press SCAN again');
      return;
    }
    scanning = true;
    panel.setScanning(true);
    clearOverlay();
    panel.setScanCount(scanCounter);
    try {
      const state = isLichess() ? readLichess() : isChessCom() ? readChessCom() : null;
      if (!state) { panel.setStatus('no board found on this page (open a chess.com/lichess board)', 'err'); return; }
      const { wK, bK } = countKings(state.grid);
      if (wK !== 1 || bK !== 1) {
        panel.setStatus(`position invalid — ${wK} white king(s), ${bK} black king(s) read. try again.`, 'err');
        return;
      }
      const fen = gridToFen(state.grid, state.flipped, panel.ui.turn);
      LOG('FEN:', fen, 'flipped:', state.flipped, 'engine:', panel.ui.engine);
      const via = panel.ui.engine === 'stockfish' ? 'stockfish' : 'vizier';
      panel.setStatus(`scanning via <b>${via}</b>…`);
      let result;
      try {
        result = via === 'stockfish'
          ? await askStockfish(fen, panel.ui.depth)
          : await askVizier(fen, panel.ui.depth);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (msg.includes('superseded')) { panel.setStatus('scan was superseded — press V again', 'err'); return; }
        if (msg.includes('no legal move')) { panel.setStatus('engine returned no move — position invalid?', 'err'); return; }
        if (msg.includes('timeout')) {
          panel.setStatus('engine timeout — worker will reload on next scan', 'err');
          sfReady = false; sf = null;
          return;
        }
        panel.setStatus('engine error: ' + msg, 'err');
        return;
      }
      if (!result || !result.move || result.move.length < 4) {
        panel.setStatus('no move returned', 'err');
        return;
      }
      const from = result.move.slice(0, 2);
      const to = result.move.slice(2, 4);
      drawArrow(state, from, to, result.eval, via);
      panel.setStatus(
        `<span class="move">${from} → ${to}</span> · ` +
        `<span class="eval">eval ${result.eval || '?'}</span> · [${via}]` +
        (panel.ui.autoMove ? ' · <b style="color:#F87171">moving…</b>' : '')
      );
      LOG('best:', from, '→', to, 'eval:', result.eval, 'via:', via);
      // Auto-move: simulate the drag on the board
      if (panel.ui.autoMove) {
        // small delay so the user sees the arrow before the move fires
        setTimeout(async () => {
          try {
            panel.setStatus(`<b style="color:#F87171">moving ${from}${to}…</b>`);
            // re-fetch state in case board moved (shouldn't have, but safety)
            const fresh = isLichess() ? readLichess() : isChessCom() ? readChessCom() : null;
            if (!fresh) { panel.setStatus('auto-move: lost board state', 'err'); return; }
            const r = await makeMove(fresh, from, to);
            if (r.ok) {
              // mark our own move to prevent the observer from re-scanning immediately
              lastScanAt = Date.now();
              lastFingerprint = boardFingerprint(fresh);
              panel.setStatus(`moved ${from}${to} · waiting for opponent…`);
              LOG('auto-moved', from, '→', to);
            } else {
              panel.setStatus('auto-move failed: ' + (r.error || '?'), 'err');
            }
          } catch (e) {
            panel.setStatus('auto-move error: ' + (e.message || e), 'err');
          }
        }, 500);
      }
    } catch (e) {
      ERR('scan failed', e);
      panel.setStatus('scan failed: ' + (e.message || e), 'err');
    } finally {
      scanning = false;
      panel.setScanning(false);
      lastScanAt = Date.now();
      panel.setScanCount(scanCounter);
    }
  }

  // ===========================================================================
  // Auto-observer
  // ===========================================================================
  function setupAutoObserver() {
    if (autoObserver) autoObserver.disconnect();
    autoObserver = new MutationObserver(() => {
      if (!panel.ui.auto || scanning) return;
      if (Date.now() - lastScanAt < 500) return;
      const state = isLichess() ? readLichess() : isChessCom() ? readChessCom() : null;
      if (!state) return;
      const fp = boardFingerprint(state);
      if (fp === lastFingerprint) return;
      lastFingerprint = fp;
      scan();
    });
    const tryAttach = () => {
      const board = document.querySelector('cg-board') || document.querySelector('chess-board') || document.querySelector('.board');
      if (board) {
        autoObserver.observe(board, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        LOG('auto observer attached to', board.tagName);
      } else {
        setTimeout(tryAttach, 1500);
      }
    };
    tryAttach();
  }

  // ===========================================================================
  // Hotkeys — capture phase so the site can't swallow them
  // ===========================================================================
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'v') { e.preventDefault(); e.stopPropagation(); LOG('hotkey V fired'); scan(); }
    else if (k === 'x') { e.preventDefault(); e.stopPropagation(); clearOverlay(); if (panel) panel.setStatus('cleared'); }
    else if (k === 'm') { e.preventDefault(); e.stopPropagation(); if (panel) panel.toggleCollapse(); }
  }
  // capture phase: runs BEFORE the site's own listeners
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('keydown', onKey, true);

  window.addEventListener('resize', () => { if (arrowEl) clearOverlay(); });

  // ===========================================================================
  // Boot
  // ===========================================================================
  (async function boot() {
    panel = buildPanel();
    panel.setStatus('booting engine…');
    panel.setEngine('loading…');
    const ok = await loadEngine((s) => panel.setStatus(s));
    if (ok) {
      panel.setStatus('ready — press <b>V</b> or click SCAN. delete any old vizier scripts from tampermonkey first.');
      panel.setEngine(sfSource);
      setupAutoObserver();
      LOG('ready. press V to scan.');
    } else {
      panel.setStatus('FAILED — no engine source loaded. check console.', 'err');
      panel.setEngine('unavailable');
      ERR('no engine source loaded');
    }
  })();
})();
