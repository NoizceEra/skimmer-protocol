# Domain — skimprotocol.fun

Registered at **Namecheap** (managed via Namecheap BasicDNS → Advanced DNS).

The domain is split across two hosts because they do different jobs:

| Hostname | Host | Serves |
|---|---|---|
| `skimprotocol.fun` (apex) | **Vercel** — project `skimmer-protocol` | the static marketing site |
| `www.skimprotocol.fun` | **Vercel** — same project | redirects to the apex |
| `app.skimprotocol.fun` | **Railway** — service `skim-v1` | Telegram bot, `POST /webhook/tx`, keeper engine, `GET /sign`, `/api/*` |

Do **not** put the apex on Railway: the marketing site is static and belongs on a CDN, and the
app needs its own hostname regardless (the `/sign` page, its `/api/*` routes and the webhook all
live on the same process).

---

## DNS records (Namecheap → Advanced DNS)

### Vercel (apex + www)

| Type | Host | Value |
|---|---|---|
| A | `@` | `216.198.79.1` |
| A | `@` | `64.29.17.1` |
| CNAME | `www` | `34097dd1bcbba5c7.vercel-dns-017.com.` |

An apex cannot be a CNAME, which is why it uses A records. The `www` CNAME is project-specific —
Vercel prints the exact value under Settings → Domains (or `vercel domains verify <domain>`).

Both hostnames are attached to the Vercel project `skimmer-protocol`.
Set `www` to **redirect to the apex** in Vercel's Domains settings.

### Railway (the app)

| Type | Host | Value |
|---|---|---|
| CNAME | `app` | `vyaqltlz.up.railway.app` |
| TXT | `_railway-verify.app` | `railway-verify=58e5d7f8debc790e414bbd8329cc1d210d55d2b6f2428b29603bde1fd170a056` |

Railway requires **both** records — the CNAME routes traffic, the TXT proves ownership so Railway
can issue the certificate. Adding only the CNAME leaves the domain stuck unverified.

The full TXT name is `_railway-verify.app.skimprotocol.fun`. The verification value is public DNS
data, not a secret.

---

## Cutover checklist — three things point at the OLD hostname

DNS itself is the easy part. If any of these are missed the product keeps *looking* fine while
silently doing nothing:

1. **`PUBLIC_URL=https://app.skimprotocol.fun`** in Railway (service `skim-v1` → Variables).
   The bot builds Telegram approval links from this; without it users get
   `skim-v1-production.up.railway.app` links. Falls back to `RAILWAY_PUBLIC_DOMAIN` when unset.

2. **Helius webhook `webhookURL`** must become `https://app.skimprotocol.fun/webhook/tx`.
   **This is the one that silently kills everything** — if Helius posts to a dead URL, no trade
   event ever reaches the listener, `queueDepth` stays 0, and no skim ever happens. There is no
   error surface for this; it just goes quiet.
   `app/src/helius.ts` preserves `webhookURL` on write-back (`PRESERVED_FIELDS`), so an address
   update will never reset it — but a *domain change* must still be applied deliberately.

3. **`web/index.html`** `canonical` and `og:url` still say `skimmer-protocol.vercel.app`.
   Update to `https://skimprotocol.fun/` and redeploy.

**Keep the old `skim-v1-production.up.railway.app` domain active** until the new one is verified —
Helius points at it today, and removing it mid-cutover breaks the webhook.

---

## Verify

```bash
# apex + TLS (Vercel)
curl -sS -o /dev/null -w "%{http_code} %{remote_ip}\n" https://skimprotocol.fun

# app liveness + TLS (Railway)
curl -sS https://app.skimprotocol.fun/health

# webhook must reject unauthenticated callers
curl -sS -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' \
  -d '[]' https://app.skimprotocol.fun/webhook/tx      # expect 401

# DNS, straight from a public resolver
nslookup app.skimprotocol.fun 8.8.8.8
nslookup -type=TXT _railway-verify.app.skimprotocol.fun 8.8.8.8
```

TLS certificates are issued automatically by both hosts once DNS resolves.

---

## Cost note

Vercel **Hobby is restricted to non-commercial use** — their fair-use policy counts
*"Any method of requesting or processing payment from visitors of the site"* as commercial, and
this protocol takes a 0.4% fee. Plan on **Vercel Pro at $20/mo**, or move the static site to a host
whose terms permit commercial use. (Cloudflare Pages' published limits page does not state a
commercial-use policy — confirm with them before relying on it.)
