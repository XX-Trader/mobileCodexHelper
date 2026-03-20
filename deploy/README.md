# Deploy Templates

- `deploy/nginx-mobile-codex.conf` is the local Windows nginx config used by the helper scripts.
  It keeps the app bound to `127.0.0.1:3001` and exposes a LAN entrypoint on `0.0.0.0:8080` limited to private-network source ranges.
- `deploy/Caddyfile.example` is an optional reverse-proxy example for users who prefer Caddy.
- `deploy/nginx-mobile-codex.conf.example` is an optional public-edge nginx example.

Keep the application itself on `127.0.0.1` and prefer a private network entrypoint.
