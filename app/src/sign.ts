/**
 * Web signing flow: approval page + API endpoints.
 *
 * Routes:
 *   GET  /sign              — self-contained HTML signing page
 *   GET  /api/approvals     — build wallet approval txs for a user (rate-limited)
 *   POST /api/rpc           — RPC proxy (keeps API key / URL server-side)
 */
import express, { type Request, type Response } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import type { AppConfig } from './config';
import { loadOnboarding, loadKeeper, type ResolvedUser, type WalletApprovalTx } from './deps';

// ── Rate limiter ──────────────────────────────────────────────────────────────

interface RateLimitEntry { count: number; resetAt: number }

export class RateLimiter {
  private map = new Map<string, RateLimitEntry>();
  constructor(private maxReqs = 30, private windowMs = 60_000) {}
  check(ip: string): boolean {
    return this.checkWithRetry(ip).allowed;
  }
  /**
   * Like check(), but also reports how many seconds the caller should wait
   * (for a `Retry-After` header) when the per-IP budget is spent.
   */
  checkWithRetry(ip: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    let entry = this.map.get(ip);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.map.set(ip, entry);
    }
    entry.count += 1;
    const allowed = entry.count <= this.maxReqs;
    const retryAfterSec = allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return { allowed, retryAfterSec };
  }
}

/** The client IP to rate-limit on: first hop of X-Forwarded-For, else the socket. */
function clientIp(req: Request): string {
  return (
    (typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0]
      : undefined
    )?.trim() ??
    req.socket?.remoteAddress ??
    'unknown'
  );
}

// ── Dependency interfaces ─────────────────────────────────────────────────────

export type ResolveUserFn = (authority: string) => ResolvedUser | null;
export type BuildApprovalsFn = (
  connection: Connection,
  p: {
    user: string;
    keeperDelegate: string;
    savingsBps: number;
    topUps?: number;
    maxUiAmount?: string;
    onlyMints?: string[];
  },
) => Promise<WalletApprovalTx[]>;

export interface SignRouteDeps {
  resolveUser: ResolveUserFn;
  buildApprovals: BuildApprovalsFn;
  rpcForward: (body: unknown) => Promise<unknown>;
  cluster: string;
  rateLimiter: RateLimiter;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const RPC_ALLOWED_METHODS = new Set([
  'sendTransaction',
  'getLatestBlockhash',
  'getRecentBlockhash',
  'getSignatureStatuses',
]);

function isValidPubkey(s: string): boolean {
  try { new PublicKey(s); return true; } catch { return false; }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

/** JSON-encode a value for inline injection into an HTML <script> block. */
function safeJsonInHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026');
}

function deriveCluster(rpcUrl: string): string {
  if (rpcUrl.includes('devnet')) return 'devnet';
  if (rpcUrl.includes('testnet')) return 'testnet';
  return 'mainnet-beta';
}

// ── HTML page ─────────────────────────────────────────────────────────────────

export function buildSignHtml(authority: string, mints: string, revoke: boolean): string {
  const pageTitle = revoke ? 'Revoke Skim Approval' : 'Approve Skim';
  const jA = safeJsonInHtml(authority);
  const jM = safeJsonInHtml(mints);
  const jR = safeJsonInHtml(revoke);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<style>
:root{--bg:#0d0d0d;--card:#1a1a1a;--bdr:#2a2a2a;--txt:#e8e8e8;--mut:#888;--acc:#7c3aed;--ok:#22c55e;--err:#ef4444}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;padding:0 16px;min-height:100vh}
.wrap{max-width:560px;margin:0 auto;padding:24px 0 48px}
h1{font-size:1.35rem;font-weight:700;margin-bottom:4px}
.sub{color:var(--mut);font-size:.9rem;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--bdr);border-radius:12px;padding:20px;margin-bottom:14px}
.lbl{font-size:.7rem;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.val{font-size:.82rem;font-family:monospace;word-break:break-all}
.row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:9px 0;border-bottom:1px solid var(--bdr)}
.row:last-child{border-bottom:none}
.row-r{font-size:.78rem;color:var(--mut);text-align:right;flex-shrink:0}
.notice{background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.3);border-radius:8px;padding:14px;font-size:.84rem;margin-bottom:14px}
.warn{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:14px;font-size:.84rem;margin-bottom:14px}
button{display:block;width:100%;padding:13px;border-radius:10px;border:none;cursor:pointer;font-size:1rem;font-weight:600;margin-bottom:10px;transition:opacity .15s}
button:disabled{opacity:.45;cursor:not-allowed}
#btnConnect{background:var(--acc);color:#fff}
#btnApprove{background:var(--ok);color:#000}
#btnRevoke{background:var(--err);color:#fff}
.st{font-size:.84rem;color:var(--mut);padding:6px 0;min-height:26px}
.st.ok{color:var(--ok)}.st.er{color:var(--err)}
.txr{font-size:.8rem;margin-top:6px}
a{color:#a78bfa}
.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--mut);border-top-color:var(--txt);border-radius:50%;animation:sp .7s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes sp{to{transform:rotate(360deg)}}
#sLoad,#sCon,#sMain,#sDone,#sEmpty{display:none}
.big{font-size:2.8rem;text-align:center;margin-bottom:10px}
</style>
</head>
<body>
<div class="wrap">
<h1 id="ptitle">${escapeHtml(pageTitle)}</h1>
<p class="sub" id="psub"></p>

<div id="sLoad" class="card"><span class="spin"></span> Loading…</div>

<div id="sCon">
<div class="warn" id="hint">Checking for a Solana wallet extension…</div>
<button id="btnConnect" disabled>Connect wallet</button>
<div class="st" id="cst"></div>
</div>

<div id="sMain">
<div class="card">
  <div class="lbl">Keeper delegate</div>
  <div class="val" id="del"></div>
</div>
<div class="card">
  <div class="lbl">Token accounts that will be ${revoke ? 'revoked' : 'approved'}</div>
  <div id="tlist"></div>
</div>
<div class="notice" id="mnote"></div>
<button id="btnApprove" style="display:none">Approve all</button>
<button id="btnRevoke" style="display:none">Revoke all</button>
<div class="st" id="ast"></div>
<div id="txr"></div>
</div>

<div id="sEmpty" class="card">
This wallet holds no token accounts yet — just make your first trade, the bot will message you when approval is needed for each new token.
</div>

<div id="sDone">
<div class="big">✅</div>
<div class="card" style="text-align:center">
<strong id="dtitle"></strong>
<p style="margin-top:8px;font-size:.9rem" id="dbody"></p>
</div>
<div id="dlnks" style="margin-top:10px"></div>
</div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.4/lib/index.iife.min.js"></script>
<script>
(function() {
'use strict';
var AUTHORITY = ${jA};
var MINTS_PARAM = ${jM};
var IS_REVOKE = ${jR};
var TOKEN_PROG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
var w3 = window.solanaWeb3;

function show(id) {
  var ids = ['sLoad','sCon','sMain','sDone','sEmpty'];
  for (var i = 0; i < ids.length; i++) {
    document.getElementById(ids[i]).style.display = ids[i] === id ? 'block' : 'none';
  }
}
function txt(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
function st(id, v, cls) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = v;
  el.className = 'st' + (cls ? ' ' + cls : '');
}

function detectWallet() {
  var w = window;
  if (w.phantom && w.phantom.solana) return w.phantom.solana;
  if (w.solana && w.solana.isPhantom) return w.solana;
  if (w.solflare && w.solflare.isSolflare) return w.solflare;
  if (w.backpack) return w.backpack;
  if (w.solana) return w.solana;
  return null;
}

var wallet = null;
var approvalData = null;

function init() {
  txt('psub', IS_REVOKE
    ? 'Revoke the keeper’s delegation so trades are no longer saved'
    : 'Approve the keeper delegate so your trades are automatically saved');

  if (!AUTHORITY) {
    txt('hint', 'Missing wallet address. Please use the link from the Telegram bot.');
    document.getElementById('btnConnect').disabled = true;
    show('sCon');
    return;
  }

  wallet = detectWallet();
  if (!wallet) {
    txt('hint', 'No Solana wallet detected. Install Phantom, Solflare, or Backpack, then reload.');
    document.getElementById('btnConnect').disabled = true;
    show('sCon');
    return;
  }
  txt('hint', 'Click below to connect. Make sure you open this link with the same wallet you /connect-ed in the bot.');
  document.getElementById('btnConnect').disabled = false;
  show('sCon');
}

document.getElementById('btnConnect').addEventListener('click', function() {
  var btn = document.getElementById('btnConnect');
  btn.disabled = true;
  st('cst', 'Connecting…');
  wallet.connect().then(function(resp) {
    var pk = null;
    if (resp && resp.publicKey) {
      pk = typeof resp.publicKey.toBase58 === 'function' ? resp.publicKey.toBase58() : String(resp.publicKey);
    } else if (wallet.publicKey) {
      pk = typeof wallet.publicKey.toBase58 === 'function' ? wallet.publicKey.toBase58() : String(wallet.publicKey);
    }
    if (!pk) throw new Error('Could not read connected pubkey');
    if (pk !== AUTHORITY) {
      var abbr = AUTHORITY.slice(0,6) + '…' + AUTHORITY.slice(-4);
      st('cst', 'Wrong wallet. This link is for ' + abbr + '. Open it with that wallet.', 'er');
      btn.disabled = false;
      return;
    }
    st('cst', 'Connected: ' + pk.slice(0,6) + '…' + pk.slice(-4), 'ok');
    fetchApprovals();
  }).catch(function(err) {
    st('cst', 'Connection failed: ' + String(err && err.message ? err.message : err), 'er');
    btn.disabled = false;
  });
});

function approvalsUrl() {
  var u = '/api/approvals?authority=' + encodeURIComponent(AUTHORITY);
  if (MINTS_PARAM) u += '&mints=' + encodeURIComponent(MINTS_PARAM);
  return u;
}

function fetchApprovals() {
  show('sLoad');
  fetch(approvalsUrl()).then(function(r) {
    if (!r.ok) return r.json().then(function(e) { throw new Error(e && e.error ? e.error : 'HTTP ' + r.status); });
    return r.json();
  }).then(function(data) {
    approvalData = data;
    var items = allItems(data);
    if (!items.length) { show('sEmpty'); return; }
    renderMain(data, items);
  }).catch(function(err) {
    show('sCon');
    st('cst', 'Failed: ' + String(err && err.message ? err.message : err), 'er');
  });
}

function allItems(data) {
  var out = [];
  if (data && data.txs) {
    for (var i = 0; i < data.txs.length; i++) {
      var items = data.txs[i].items || [];
      for (var j = 0; j < items.length; j++) out.push(items[j]);
    }
  }
  return out;
}

function renderMain(data, items) {
  var delEl = document.getElementById('del');
  delEl.textContent = data.delegate || '';

  var tlist = document.getElementById('tlist');
  tlist.innerHTML = '';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var row = document.createElement('div');
    row.className = 'row';

    var left = document.createElement('div');
    var m = document.createElement('div');
    m.className = 'val';
    m.textContent = item.mint.slice(0,8) + '…' + item.mint.slice(-4);
    m.title = item.mint;
    var ta = document.createElement('div');
    ta.style.cssText = 'font-size:.73rem;color:var(--mut);font-family:monospace';
    ta.textContent = 'ATA: ' + item.tokenAccount.slice(0,6) + '…' + item.tokenAccount.slice(-4);
    left.appendChild(m);
    left.appendChild(ta);

    var right = document.createElement('div');
    right.className = 'row-r';
    right.textContent = IS_REVOKE ? 'revoke' : ('max ' + item.allowanceBaseUnits);
    right.title = IS_REVOKE ? '' : (item.allowanceBaseUnits + ' base units');

    row.appendChild(left);
    row.appendChild(right);
    tlist.appendChild(row);
  }

  var note = document.getElementById('mnote');
  if (IS_REVOKE) {
    note.textContent = 'This will REVOKE the keeper’s delegation on each token. Future trades will NOT be auto-saved until you re-approve.';
    document.getElementById('btnApprove').style.display = 'none';
    document.getElementById('btnRevoke').style.display = 'block';
  } else {
    var dAbbr = (data.delegate || '').slice(0,8) + '…';
    note.textContent = 'Keeper ' + dAbbr + ' gets a BOUNDED, REVOCABLE allowance — never unlimited. It never holds your keys. Revocable any time.';
    document.getElementById('btnApprove').style.display = 'block';
    document.getElementById('btnRevoke').style.display = 'none';
  }

  show('sMain');
}

document.getElementById('btnApprove').addEventListener('click', function() { doSign(false); });
document.getElementById('btnRevoke').addEventListener('click', function() { doSign(true); });

function doSign(revoke) {
  var btn = document.getElementById(revoke ? 'btnRevoke' : 'btnApprove');
  btn.disabled = true;
  st('ast', 'Re-fetching fresh transactions…');

  fetch(approvalsUrl()).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function(data) {
    approvalData = data;
    var items = allItems(data);
    if (!items.length) { show('sEmpty'); return; }
    if (revoke) {
      buildAndSignRevokes(data, items);
    } else {
      signApproves(data.txs || [], data.cluster || 'devnet');
    }
  }).catch(function(err) {
    st('ast', 'Error: ' + String(err && err.message ? err.message : err), 'er');
    btn.disabled = false;
  });
}

function signApproves(txs, cluster) {
  st('ast', 'Waiting for wallet signature…');
  var results = document.getElementById('txr');
  results.innerHTML = '';
  var idx = 0;

  function next() {
    if (idx >= txs.length) {
      st('ast', 'All approved!', 'ok');
      show('sDone');
      txt('dtitle', 'Approved!');
      txt('dbody', 'The keeper will auto-save from future trades of these tokens.');
      return;
    }
    var tx = txs[idx]; idx++;
    st('ast', 'Signing tx ' + idx + ' of ' + txs.length + '…');
    var bytes;
    try {
      var b64 = tx.base64;
      bytes = Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); });
    } catch(e) {
      st('ast', 'Decode error on tx ' + idx, 'er');
      return;
    }
    var desTx = w3.Transaction.from(bytes);
    wallet.signTransaction(desTx).then(function(signed) {
      var raw = signed.serialize();
      var enc = btoa(String.fromCharCode.apply(null, Array.from(raw)));
      return fetch('/api/rpc', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({jsonrpc:'2.0',id:idx,method:'sendTransaction',params:[enc,{encoding:'base64',skipPreflight:false}]})
      });
    }).then(function(r) { return r.json(); }).then(function(resp) {
      if (resp && resp.result) {
        addTxLink(results, idx, resp.result, cluster);
        next();
      } else {
        var em = resp && resp.error && resp.error.message ? resp.error.message : JSON.stringify(resp);
        st('ast', 'RPC error on tx ' + idx + ': ' + em, 'er');
      }
    }).catch(function(err) {
      st('ast', 'Error on tx ' + idx + ': ' + String(err && err.message ? err.message : err), 'er');
    });
  }
  next();
}

function buildAndSignRevokes(data, items) {
  if (!w3) { st('ast', 'web3.js not loaded', 'er'); return; }
  var cluster = data.cluster || 'devnet';
  var owner = wallet.publicKey;
  var progId = new w3.PublicKey(TOKEN_PROG);

  var ixs = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    ixs.push(new w3.TransactionInstruction({
      programId: progId,
      keys: [
        {pubkey: new w3.PublicKey(item.tokenAccount), isSigner: false, isWritable: true},
        {pubkey: owner, isSigner: true, isWritable: false}
      ],
      data: new Uint8Array([8])
    }));
  }

  st('ast', 'Fetching blockhash…');
  fetch('/api/rpc', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getLatestBlockhash',params:[{commitment:'confirmed'}]})
  }).then(function(r) { return r.json(); }).then(function(resp) {
    if (!resp || !resp.result || !resp.result.value) throw new Error('getLatestBlockhash failed');
    var blockhash = resp.result.value.blockhash;
    var BATCH = 6;
    var txList = [];
    for (var i = 0; i < ixs.length; i += BATCH) {
      var chunk = ixs.slice(i, i + BATCH);
      var tx = new w3.Transaction();
      tx.feePayer = owner;
      tx.recentBlockhash = blockhash;
      for (var j = 0; j < chunk.length; j++) tx.add(chunk[j]);
      txList.push(tx);
    }

    var results = document.getElementById('txr');
    results.innerHTML = '';
    var idx = 0;
    st('ast', 'Sign ' + txList.length + ' revoke tx(s) in your wallet…');

    function nextRevoke() {
      if (idx >= txList.length) {
        st('ast', 'All revoked!', 'ok');
        show('sDone');
        txt('dtitle', 'Revoked!');
        txt('dbody', 'Keeper delegation removed. Re-approve from the bot when needed.');
        return;
      }
      var tx = txList[idx]; idx++;
      wallet.signTransaction(tx).then(function(signed) {
        var raw = signed.serialize();
        var enc = btoa(String.fromCharCode.apply(null, Array.from(raw)));
        return fetch('/api/rpc', {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({jsonrpc:'2.0',id:idx,method:'sendTransaction',params:[enc,{encoding:'base64',skipPreflight:false}]})
        });
      }).then(function(r) { return r.json(); }).then(function(resp) {
        if (resp && resp.result) {
          addTxLink(results, idx, resp.result, cluster);
          nextRevoke();
        } else {
          var em = resp && resp.error && resp.error.message ? resp.error.message : JSON.stringify(resp);
          st('ast', 'RPC error: ' + em, 'er');
        }
      }).catch(function(err) {
        st('ast', 'Error: ' + String(err && err.message ? err.message : err), 'er');
      });
    }
    nextRevoke();
  }).catch(function(err) {
    st('ast', 'Blockhash error: ' + String(err && err.message ? err.message : err), 'er');
  });
}

function addTxLink(container, n, sig, cluster) {
  var row = document.createElement('div');
  row.className = 'txr';
  var a = document.createElement('a');
  a.href = 'https://explorer.solana.com/tx/' + encodeURIComponent(sig) + '?cluster=' + encodeURIComponent(cluster);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Tx ' + n + ': ' + sig.slice(0,12) + '…';
  row.appendChild(a);
  container.appendChild(row);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
})();
</script>
</body>
</html>`;
}

// ── Real dependency loader ────────────────────────────────────────────────────

function loadRealDeps(config: AppConfig, connection: Connection, keeperPubkey: string): SignRouteDeps {
  const keeper = loadKeeper();
  const resolveUser = keeper.makeUserResolver(config.userStorePath);
  const onboarding = loadOnboarding();

  const rpcForward = async (body: unknown): Promise<unknown> => {
    const res = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  return {
    resolveUser,
    buildApprovals: onboarding.buildWalletApprovals as BuildApprovalsFn,
    rpcForward,
    cluster: deriveCluster(config.rpcUrl),
    rateLimiter: new RateLimiter(),
  };
}

// ── Route mount ───────────────────────────────────────────────────────────────

export function mountSignRoutes(
  app: express.Express,
  config: AppConfig,
  connection: Connection,
  keeperPubkey: string,
  injected?: Partial<SignRouteDeps>,
): void {
  let depsCache: SignRouteDeps | null = null;
  const getDeps = (): SignRouteDeps => {
    if (!depsCache) {
      depsCache = { ...loadRealDeps(config, connection, keeperPubkey), ...injected };
    }
    return depsCache;
  };

  const jsonParser = express.json({ limit: '4kb' });

  // ── GET /api/approvals ──────────────────────────────────────────────────────
  app.get('/api/approvals', async (req: Request, res: Response) => {
    const deps = getDeps();
    const limit = deps.rateLimiter.checkWithRetry(clientIp(req));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const authority = typeof req.query.authority === 'string' ? req.query.authority.trim() : '';
    if (!authority || !isValidPubkey(authority)) {
      res.status(400).json({ error: 'invalid or missing authority pubkey' });
      return;
    }

    const user = deps.resolveUser(authority);
    if (!user || user.savingsBps <= 0 || !user.destination) {
      res.status(404).json({ error: 'user not found or not configured' });
      return;
    }

    const mintsParam = typeof req.query.mints === 'string' ? req.query.mints : undefined;
    const onlyMints = mintsParam
      ? mintsParam.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    const maxUiAmount = process.env.MAX_ALLOWANCE_UI ?? '100';

    let txs: WalletApprovalTx[];
    try {
      txs = await deps.buildApprovals(connection, {
        user: authority,
        keeperDelegate: user.delegate || keeperPubkey,
        savingsBps: user.savingsBps,
        maxUiAmount,
        onlyMints,
      });
    } catch {
      res.status(500).json({ error: 'failed to build approval transactions' });
      return;
    }

    // Never include RPC URL or any secret in the response
    res.status(200).json({
      delegate: user.delegate || keeperPubkey,
      cluster: deps.cluster,
      txs,
    });
  });

  // ── POST /api/rpc ───────────────────────────────────────────────────────────
  app.post('/api/rpc', jsonParser, async (req: Request, res: Response) => {
    // Same per-IP limiter the /api/approvals route uses. The method allowlist
    // stops this being an open relay, but an unthrottled loop would still burn
    // the operator's paid RPC credits — so bound it per client.
    const deps = getDeps();
    const limit = deps.rateLimiter.checkWithRetry(clientIp(req));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSec));
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'invalid request body' });
      return;
    }
    const method = typeof body.method === 'string' ? body.method : '';
    if (!RPC_ALLOWED_METHODS.has(method)) {
      res.status(403).json({ error: `method not allowed: ${escapeHtml(method)}` });
      return;
    }
    try {
      const result = await deps.rpcForward(body);
      res.status(200).json(result);
    } catch {
      res.status(502).json({ error: 'rpc forward failed' });
    }
  });

  // ── GET /sign ───────────────────────────────────────────────────────────────
  app.get('/sign', (req: Request, res: Response) => {
    const authority = typeof req.query.a === 'string' ? req.query.a : '';
    const mints = typeof req.query.m === 'string' ? req.query.m : '';
    const revoke = req.query.revoke === '1';

    res.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(buildSignHtml(authority, mints, revoke));
  });
}
