# tail-gateway

Friendly `https://<name>.tail` addresses for local services, tailnet only. Built 1 Nov 2026.

```
iPhone / iPad / Mac on the tailnet
   |  DNS: Tailscale split DNS "tail" -> 100.101.41.38 (admin console > DNS)
   v
tail-gateway node (100.101.41.38, a second userspace tailscaled on this Mac)
   |  :53  CoreDNS: every *.tail -> 100.101.41.38 (tailnet + loopback clients only)
   |  :443 tailscale serve tcp -> 127.0.0.1:7443  Caddy, TLS from the .tail CA
   |  :80  tailscale serve tcp -> 127.0.0.1:7080  Caddy, redirects to https
   v
127.0.0.1:<port> services (routes in ~/.config/tail-gateway/routes.json)
```

The node has its own tailnet IP, so ports 443/80/53 there don't clash with the main
`abdullahs-macbook-pro` node, whose `tailscale serve` ports (`*.tailcca332.ts.net:<port>`) keep working
unchanged for backward compatibility.

## Use

```bash
tailname add robob 3773 --note "Robob app"          # https://robob.tail
tailname add builds 8461 --path /robob              # https://builds.tail/robob/ (prefix stripped)
tailname add docs --dir ~/some/site                 # static folder
tailname rm builds --path /robob
tailname list
tailname check            # resolve + fetch every route; DOWN = nothing on the local port
```

`https://gateway.tail` lists every name. A new device installs the profile from
`https://tail-gateway.tailcca332.ts.net:8443/tail-ca.mobileconfig` (real ts.net cert, so it can't be swapped
on a hostile network), then Settings > General > VPN & Device Management > install, then Settings > General >
About > Certificate Trust Settings > turn on "Abdullah Tailnet .tail CA". `http://gateway.tail` serves the
same file as a fallback. CA SHA-256: `DA:7C:70:D1:9B:5D:DF:92:D0:FF:0B:7C:FD:9E:4F:40:E9:79:FE:E4:8D:E5:87:AF:7B:17:F6:0A:CE:35:96:5F`.

## Pieces

| Repo | Live | What |
| --- | --- | --- |
| `bin/tailname` | `~/.local/share/tail-gateway/bin/` + link `~/.local/bin/tailname` | route CLI, renders the Caddyfile and reloads Caddy |
| `bin/tail-gateway-site` | same | builds `www/` (landing page, `ca.crt`, `tail-ca.mobileconfig`) |
| `bin/tail-gateway-run` | same | launchd entry: `node`, `dns`, `proxy` |
| `dns/Corefile` | `~/.local/share/tail-gateway/Corefile` | CoreDNS for `tail.` |
| `launchd/*.plist` | `~/Library/LaunchAgents/` | `com.ardud.tail-gateway-{node,dns,proxy}` |

Live-only, never in the repo: `ca/root.key` (mode 600; name-constrained to `.tail`, so it can't sign any
real domain), `ts-state/` (the node's Tailscale identity), `caddy-data/` (issued leaf certs, auto-renewed),
the `tailscaled`/`tailscale` binaries (copied from `~/.local/share/juno-router`), `logs/`, and
`~/.config/tail-gateway/routes.json`.

```bash
./install.zsh --check     # drift, key mode, agents loaded
./install.zsh             # push first; --allow-unpushed for testing
/usr/bin/python3 -m unittest discover -s tests
```

## First-time setup (already done on this Mac)

1. Copy `tailscaled`/`tailscale` into `~/.local/share/tail-gateway/`, start the node, `tailscale up
   --hostname=tail-gateway --accept-dns=false` with a one-off auth key from the admin console, approve it.
2. `tailscale --socket=... serve --bg --tcp 443 tcp://127.0.0.1:7443`, `--tcp 80 tcp://127.0.0.1:7080`, and
   `--https=8443 http://127.0.0.1:7080` (the profile download with a real ts.net cert).
3. CA: EC P-256 root with `nameConstraints = critical, permitted;DNS:tail`, in `ca/root.{crt,key}`.
4. Admin console > DNS > Add nameserver > Custom: `100.101.41.38`, Split DNS, domain `tail`.
   Reload the page afterwards to check it saved (the first save on 1 Nov only showed client-side).
5. Mac trust: `security add-trusted-cert -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db ca/root.crt`.

## Security

- Caddy's admin API is a unix socket (`caddy-admin.sock`), never TCP. A userspace tailscaled forwards any
  tailnet connection to its IP into this Mac's 127.0.0.1, so a TCP admin port would let any tailnet device
  rewrite the gateway.
- The same forwarding means 100.101.41.38:<port> (and juno-router's 100.113.80.124:<port>) reach every
  loopback service, e.g. Dia's CDP on 9222. Only Abdullah's own devices are on the tailnet. The real fix is
  a tagged ACL that allows only 80/443/53 to the gateway (see the 1 Nov review in the thread); not applied
  yet because the policy is allow-all and juno-router needs its own port list first.
- CoreDNS has no forwarder and refuses anyone but loopback/tailnet, so it is never an open resolver.

## Notes

- The node's key expiry is disabled in the admin console (Machines > tail-gateway), like the main Mac.
- Names are DNS labels: lowercase letters, digits, dashes. `gateway` is reserved.
- Single-label `tail` split DNS is verified on macOS 27 with Tailscale 1.102.4 (1 Nov). After adding the
  route the Mac's resolver only picked it up after Tailscale re-applied DNS; give it a minute.
