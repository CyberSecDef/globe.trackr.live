#!/usr/bin/env bash
#
# Build globe.trackr.live and rsync dist/ to DreamHost.
#
#   ./deploy/deploy.sh --install-key   one-time: put your SSH key on the server
#   ./deploy/deploy.sh --dry-run       show what would change, transfer nothing
#   ./deploy/deploy.sh                 build and deploy
#   ./deploy/deploy.sh --no-build      deploy the dist/ that is already there
#
# The server's Node is v12; vite 8 needs >=20.19. Building there is impossible,
# so the build always happens here and only dist/ crosses the wire.
#
# Settings come from .env.local in the repo root (gitignored). Only USER and
# PASS are required, and PASS is only ever read by --install-key:
#
#   DREAMHOST_USER=dh_xxxxxx
#   DREAMHOST_PASS=...              # only used by --install-key
#   DREAMHOST_HOST=...              # optional, defaults below
#   DREAMHOST_DOMAIN=...            # optional, defaults below
#   DREAMHOST_PATH=...              # optional, auto-detected when unset
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

DEFAULT_HOST="vps30818.dreamhostps.com"
DEFAULT_DOMAIN="globe.trackr.live"
SSH_KEY="${HOME}/.ssh/id_ed25519_dreamhost"

BUILD=1
DRY_RUN=0
INSTALL_KEY=0
for arg in "$@"; do
  case "$arg" in
    --no-build)    BUILD=0 ;;
    --dry-run)     DRY_RUN=1 ;;
    --install-key) INSTALL_KEY=1 ;;
    -h|--help)     sed -n '3,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

# ------------------------------------------------------------------ settings

[[ -f .env.local ]] || die ".env.local not found. See the header of this script."

# Sourced rather than parsed so a password with $ or quotes in it survives.
# shellcheck disable=SC1091
set -a; source .env.local; set +a

: "${DREAMHOST_USER:?DREAMHOST_USER is not set in .env.local}"
HOST="${DREAMHOST_HOST:-$DEFAULT_HOST}"
DOMAIN="${DREAMHOST_DOMAIN:-$DEFAULT_DOMAIN}"
TARGET="${DREAMHOST_USER}@${HOST}"

# ------------------------------------------------------------- one-time: key

if [[ $INSTALL_KEY -eq 1 ]]; then
  : "${DREAMHOST_PASS:?DREAMHOST_PASS is not set in .env.local}"
  [[ -f "${SSH_KEY}.pub" ]] || die "no public key at ${SSH_KEY}.pub"
  command -v sshpass >/dev/null || die "sshpass is not installed"

  echo "Installing $(basename "${SSH_KEY}.pub") on ${TARGET} ..."
  # SSHPASS via the environment, never on the command line, where it would show
  # up in this machine's process list for every other user to read.
  SSHPASS="$DREAMHOST_PASS" sshpass -e \
    ssh-copy-id -i "${SSH_KEY}.pub" -o StrictHostKeyChecking=accept-new "$TARGET"

  if ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" true 2>/dev/null; then
    echo "Key auth works. You can delete DREAMHOST_PASS from .env.local now."
  else
    die "key installed but key-only login still fails"
  fi
  exit 0
fi

# ------------------------------------------------------------------- reachable

ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" true 2>/dev/null \
  || die "cannot reach ${TARGET} with key auth. Run: $0 --install-key"

# -------------------------------------------------------------- where it goes

if [[ -n "${DREAMHOST_PATH:-}" ]]; then
  REMOTE_DIR="$DREAMHOST_PATH"
else
  # DreamHost makes ~/<domain>/ the web root for a plain domain, and
  # ~/<domain>/public/ when the panel's web directory was set that way (which
  # is how the Laravel sites on this VPS are laid out). Ask, rather than guess.
  REMOTE_DIR="$(ssh -i "$SSH_KEY" "$TARGET" "
    if   [ -d \"\$HOME/${DOMAIN}/public\" ]; then echo \"\$HOME/${DOMAIN}/public\"
    elif [ -d \"\$HOME/${DOMAIN}\" ];        then echo \"\$HOME/${DOMAIN}\"
    fi")"
  [[ -n "$REMOTE_DIR" ]] || die "no ~/${DOMAIN} on the server. Add the domain in the DreamHost panel first, or set DREAMHOST_PATH in .env.local."
fi

# rsync --delete into the wrong directory eats a home directory. Require the
# target to look like this domain's web root and to be at least two levels deep.
case "$REMOTE_DIR" in
  */"${DOMAIN}"|*/"${DOMAIN}"/public) ;;
  *) die "refusing to deploy to '${REMOTE_DIR}': does not look like ${DOMAIN}'s web root" ;;
esac

# ------------------------------------------------------------------- build

if [[ $BUILD -eq 1 ]]; then
  echo "Building ..."
  npm run build
else
  [[ -f dist/index.html ]] || die "no dist/index.html and --no-build was given"
  # Shipping a dist/ older than the sources it came from is the classic way to
  # spend an afternoon debugging a fix that was never uploaded.
  if [[ -n "$(find src index.html public vite.config.js -newer dist/index.html -print -quit 2>/dev/null)" ]]; then
    die "dist/ is older than the sources. Drop --no-build."
  fi
fi

[[ -f dist/index.html ]] || die "build produced no dist/index.html"
[[ -f dist/.htaccess  ]] || echo "warning: dist/.htaccess is missing; compression and caching will be off" >&2

# ------------------------------------------------------------------ transfer

RSYNC_FLAGS=(-az --delete --human-readable --stats
             --chmod=D755,F644
             --exclude '.dh-diag' --exclude '.well-known/')
[[ $DRY_RUN -eq 1 ]] && RSYNC_FLAGS+=(--dry-run --itemize-changes)

echo
echo "  from  ${ROOT}/dist/"
echo "  to    ${TARGET}:${REMOTE_DIR}/"
[[ $DRY_RUN -eq 1 ]] && echo "  (dry run -- nothing will be written)"
echo

# .well-known and DreamHost's own .dh-diag symlink live in the web root and are
# not ours; excluding them also protects them from --delete, which would
# otherwise break Let's Encrypt renewal.
rsync "${RSYNC_FLAGS[@]}" -e "ssh -i ${SSH_KEY}" ./dist/ "${TARGET}:${REMOTE_DIR}/"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "Dry run complete."
  exit 0
fi

# -------------------------------------------------------------------- verify

echo
URL="https://${DOMAIN}/"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$URL" 2>/dev/null || echo 000)"
if [[ "$CODE" == "200" ]]; then
  ENC="$(curl -sS -o /dev/null -D - -H 'Accept-Encoding: gzip, br' --max-time 20 "$URL" 2>/dev/null \
         | grep -i '^content-encoding:' | tr -d '\r' || true)"
  echo "Deployed. ${URL} -> 200 ${ENC:+(${ENC})}"
  if [[ -z "$ENC" ]]; then
    echo "note: no content-encoding on the HTML; check that mod_deflate is enabled." >&2
  fi
else
  echo "Deployed, but ${URL} returned ${CODE}." >&2
  echo "If DNS or the Let's Encrypt certificate is still propagating, that is expected." >&2
  exit 1
fi
# `cmd && echo` as the last statement would make a successful deploy exit 1
# whenever the test was false. Be explicit instead.
exit 0
