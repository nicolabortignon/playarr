# Listening away from home: a public HTTPS address

Away from home, phones and computers reach Playarr at its public address, over HTTPS. This page gets you one, two ways:

- **Caddy with your own domain** (below): `music.example.com` for anyone you invite, on any network. It needs a domain whose DNS you control and a router you can forward ports on.
- **Tailscale** (further down): no domain and no open ports, but every phone needs the Tailscale app and a place in your tailnet.

Either way, **Settings → Away from home** (web and iOS, admins) then checks the address from the server itself and says what to fix. The files are `docker/compose.yaml` (the `playarr-caddy` service), `docker/Caddyfile` and `.env.example`; the check is `apps/server/src/reachability/`.

---

## 1. Caddy with your own domain

Caddy is a small web server in Playarr's compose stack, off unless `.env` turns it on. It answers on ports 80 and 443, gets a certificate for your domain from Let's Encrypt and renews it by itself, and hands every request to Playarr.

### Before you start

- **A domain**, or a name under one, whose DNS records you can add: `music.example.com` here.
- **Your home's public address**, from your router's status page.
- **Ports 80 and 443 free** on the machine Playarr runs on. Some NAS systems' own web server takes them.

### Steps

1. **DNS.** At your domain's DNS provider, add an **A record** for `music.example.com` with your home's public address. Add an AAAA record only if you know your router lets IPv6 connections in to this machine. A new record can take a few minutes to show up. If your home's address changes now and then, keep the record up to date with your provider's or your router's dynamic DNS.
2. **Router.** Give the machine a fixed address on the home network (a DHCP reservation), then forward **TCP ports 80 and 443** to it, and nothing else. Never forward 4000: through Docker's port mapping a visitor from the internet can reach Playarr from a home address (the Docker network's gateway), and a server nobody has claimed yet lets the home network claim it and change its settings.
3. **`.env`.** In Playarr's folder (e.g. `/volume1/docker/playarr`), add:

   ```
   COMPOSE_PROFILES=https
   PLAYARR_DOMAIN=music.example.com
   ```

   With `PLAYARR_DOMAIN`, Playarr's address (`PUBLIC_URL`) is `https://music.example.com` and the only proxy it believes about visitors (`TRUST_PROXY`) is Caddy. Lines of your own for those two win, so remove old ones you don't mean.
4. **Start it.** In that folder: `sudo docker compose up -d`. It starts Caddy and restarts Playarr with the new settings. Caddy has its certificate within a minute: `sudo docker compose logs playarr-caddy` says "certificate obtained successfully".
5. **Check.** Settings → Away from home → **Check now**. Then open `https://music.example.com` on a phone on mobile data, Wi-Fi off. In the iOS app, add the server by that address.

Updates keep Caddy running and up to date (`update.sh` and Settings → Updates start it while the profile is on). Its certificates are in `caddy/` next to `compose.yaml`: keep that folder. To turn it off, remove the two lines and run `sudo docker compose rm -sf playarr-caddy` and `sudo docker compose up -d`.

### Why Playarr believes Caddy alone

Behind a proxy every request comes from the proxy, so Playarr reads the visitor's address and protocol from the proxy's `X-Forwarded-For` and `-Proto`, but only from a proxy it trusts: sign-in limits then count per visitor, and cookies are marked Secure. With `PLAYARR_DOMAIN` that's `TRUST_PROXY=playarr-caddy`: the address the name `playarr-caddy` (Caddy's service) has on the compose network, looked up again every 30 s and when a request suggests Caddy moved, since Docker gives a container a new address when it's made again (`apps/server/src/proxyNames.ts`). Not every private address: the Docker gateway is one, and visitors through the published port 4000 can come from it. Not a pinned address either: that would need a network with a fixed subnet that Playarr joins in every deployment, which could clash with an owner's own networks. Requests through Caddy never count as the home network ([accounts-and-access.md](accounts-and-access.md)).

### When the check fails

| The check says | What to do |
|---|---|
| PUBLIC_URL isn't set | Add the `.env` lines, then `sudo docker compose up -d`. |
| … doesn't resolve | Add the A record; wait a few minutes. |
| No answer, or connection refused | Many routers don't let a machine reach the home's own public address from inside (no hairpin NAT): try the address from a phone on mobile data. If it fails there too, check the forwarding and that Caddy runs (`sudo docker compose ps`). If your provider shares one public address among many homes (CGNAT), forwarding can't work: use Tailscale. |
| A certificate problem | `sudo docker compose logs playarr-caddy`: Let's Encrypt must reach Caddy on port 80 or 443, and the name must lead to your home. From inside, some routers answer their public address with their own page: try a phone on mobile data. |
| Something answered, but not this server | The name or the forwarding leads to another machine: check the A record and the router. |
| The proxy answered 502 | Caddy can't reach Playarr: `sudo docker compose ps` should show both running. |

Caddy itself keeps restarting:

- Its log says `server block without any key`: `PLAYARR_DOMAIN` isn't set.
- It says `address already in use`: something else on the machine has port 80 or 443. Free them, or use that web server as your proxy instead (below).

### Your own proxy instead

Already running nginx, Traefik or your NAS's reverse proxy? Point it at `http://<machine>:4000`, set `PUBLIC_URL` to its https address, and set `TRUST_PROXY` to the proxy's address as Playarr sees it (`.env.example` says how to find it). Leave `COMPOSE_PROFILES` and `PLAYARR_DOMAIN` out.

---

## 2. Tailscale, without a domain

Tailscale joins your devices into a private network, a tailnet. `tailscale serve` gives the server an HTTPS address on it, `https://<machine>.<tailnet>.ts.net`, with a real certificate, and only devices in your tailnet can open it. No ports to forward, no domain.

1. **Install Tailscale on the machine Playarr runs on**, not in a container (from tailscale.com/download, or your NAS's app center), and sign in (`sudo tailscale up`, or the app's own sign-in).
2. **Turn on HTTPS for the tailnet:** in Tailscale's admin console, on the DNS page, turn on MagicDNS and, under HTTPS Certificates, Enable HTTPS. Your machines' names become public in certificate logs, so rename one whose name says too much first.
3. **Serve Playarr:** `sudo tailscale serve --bg 4000`. It prints the address, proxying to `http://127.0.0.1:4000`, and keeps serving after restarts. `tailscale serve status` shows it; `sudo tailscale serve reset` stops it (and anything else the machine serves).
4. **`.env`:** `PUBLIC_URL=https://<machine>.<tailnet>.ts.net`, then `sudo docker compose up -d`.
5. **Phones:** install the Tailscale app and sign in to the same tailnet. For family members, invite them to it, or share just this machine with them, from the admin console.
6. **Check:** open the address on a phone with Tailscale on and Wi-Fi off. Settings → Away from home checks it too, but from inside Docker the server may not reach its own tailnet address: when it can't, it says so rather than calling the setup broken.

`TRUST_PROXY` can stay unset here: Tailscale reaches Playarr through the published port, from the Docker gateway, the same address as visitors at home may have, so believing it would mean believing them too. Visitors through `tailscale serve` still don't count as the home network (they come by the ts.net name), and setup links use `PUBLIC_URL`.

---

## 3. How the check works

`POST /api/settings/reachability/check` (admins; `apps/server/src/reachability/reachability.ts`) asks the server's own public address the way a phone would, in steps, each with what it found and what to do:

1. **Public address**: `PUBLIC_URL` is set, `https://`, and not a home address (`192.168.…`, `nas.local`).
2. **Name lookup**: the name resolves, from the server's own resolver, within 3 s. A name that leads only to home addresses (the router or a local DNS answering it) is a warning: fine at home, unproven outside.
3. **Connection**: at the first IPv4 address, then the first IPv6 one, within 5 s.
4. **Certificate**: the server accepts it, for the name, from the system's authorities.
5. **This server answers**: `GET /reachable/<token>` with a one-time token the server made for this check. Only this server knows the answer to its token, so another server, the router's page, or a page that answers every path can't pass.

The verdict is reachable (every step passed), unreachable (one failed for sure), or **unconfirmed**: the server couldn't tell from inside the home, because the name led only to home addresses, the connection failed at a public or tailnet address, or a certificate came from what may be the router's own page. Then the advice is to try from a phone on mobile data (with Tailscale on, for a ts.net address). Nothing goes to anyone else: the only requests are the name's lookup and the server's own address.

`GET /reachable/:token` is open and outside `/api/`, since the check's request comes through the proxy without a session. It answers only tokens of a check that's running, once each (a token lives at most 30 s), with a plain 404 for anything else, and at most 30 requests a minute per visitor.
