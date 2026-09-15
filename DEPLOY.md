# Deploying to DreamHost

`dist/` is plain static files, so a deploy is a build and an rsync. There is no
backend, no database, no server-side runtime.

## Once, per machine

`.env.local` in the repo root, gitignored:

```sh
DREAMHOST_USER=dh_xxxxxx
DREAMHOST_PASS=...          # only read by --install-key; delete it afterwards
```

Optional overrides, all with sensible defaults:

```sh
DREAMHOST_HOST=vps30818.dreamhostps.com
DREAMHOST_DOMAIN=globe.trackr.live
DREAMHOST_PATH=/home/dh_xxxxxx/globe.trackr.live    # auto-detected when unset
```

Then install the SSH key so nothing ever needs the password again:

```bash
./deploy/deploy.sh --install-key
```

This pushes `~/.ssh/id_ed25519_dreamhost.pub` — the same key the other three
DreamHost accounts on this VPS use — and verifies that key-only login works
before it reports success. Delete `DREAMHOST_PASS` once it does.

## Every time

```bash
./deploy/deploy.sh --dry-run    # what would change
./deploy/deploy.sh              # build, then rsync
```

It refuses to run if it cannot reach the server, if the build produced no
`dist/index.html`, or if the remote path does not look like this domain's web
root — `rsync --delete` aimed at a home directory is not a recoverable mistake.
Afterwards it requests the live URL and reports the status code and whether the
response came back compressed.

`--no-build` deploys the existing `dist/`, and refuses if that `dist/` is older
than the sources it came from.

## Prerequisites in the DreamHost panel

Three things the script cannot do:

1. **DNS.** An A record for `globe.trackr.live`. The other trackr.live sites on
   this VPS point at `208.97.156.39`.
2. **Hosted domain.** Adding it under the account creates the web directory and
   the Apache vhost. The script auto-detects whether the web root is
   `~/globe.trackr.live/` or `~/globe.trackr.live/public/`.
3. **HTTPS.** DreamHost's free Let's Encrypt certificate. It will not issue
   until DNS resolves, so do this last.

## Why the build never runs on the server

The VPS has Node v12.22.9. Vite 8 requires `^20.19.0 || >=22.12.0`. There is no
`git pull && npm run build` workflow available and there will not be one — the
build happens here and only `dist/` crosses the wire.

## Apache config

`public/.htaccess` ships automatically: vite copies dotfiles from `public/` into
`dist/`. Every block is `<IfModule>`-guarded, so a module that is unavailable is
a no-op rather than a 500. `deflate`, `brotli`, `expires`, `headers` and
`rewrite` are all present on this VPS.

It sets compression, cache headers, and a Content-Security-Policy whose
`connect-src` is exactly the eight APIs `src/data/provider.js` uses. **Adding a
data source means adding its origin there too**, or that section of the
inspector fails silently.

Compression is worth about 680 KB of the ~4 MB payload — the JS bundle drops
598K to 153K and `earth-cities.json` 338K to 132K. The five baked rasters are
already PNG and JPEG and do not compress, which is why they are not enrolled.
They get cache headers instead: hashed build output is `immutable`, the
stable-named `earth-*` files get a week with revalidation, and `index.html` is
`no-cache` because it is the only file naming the current bundle.

## After the first deploy

Check that the CSP survived contact with the real server — click a tile and
watch the browser console. Zero violations is the expected result; it was
verified locally against these exact headers with all eight lookups firing.

## Licensing, before this goes anywhere commercial

Open-Meteo's free API tier is non-commercial only, and each tile click hits up
to four of its endpoints. The Köppen climate channel is CC BY-NC 4.0. See
[DATA-LICENSES.md](DATA-LICENSES.md).
