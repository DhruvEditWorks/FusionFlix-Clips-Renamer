#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# FUSION FLIX — publish this folder to GitHub in one shot.
#
#   GITHUB_TOKEN=ghp_xxx ./tools/publish-to-github.sh
#
# What it does:
#   1. commits the source tree into a fresh git history (node_modules, dist and
#      the 60-180 MB FFmpeg binaries are ignored)
#   2. pushes it to the repo's default branch
#   3. creates the release for the version in package.json
#   4. uploads "Fusion Flix Clip Renamer & Sorter Setup.exe" as a release asset
#      (GitHub allows repo files up to 25 MB — the installer must live on the
#      Releases page, which is exactly what the README links to)
#
# The token needs, on this repository only:
#   Contents: Read and write   ·   (Releases are covered by Contents)
# Nothing is written to .git/config — the token is only passed on the command
# line, so it is never stored on disk.
# ---------------------------------------------------------------------------
set -euo pipefail

OWNER="${GITHUB_OWNER:-DhruvEditWorks}"
REPO="${GITHUB_REPO:-FusionFlix-Clips-Renamer}"
BRANCH="${GITHUB_BRANCH:-main}"
TOKEN="${GITHUB_TOKEN:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -z "$TOKEN" ]; then
  echo "error: set GITHUB_TOKEN first — e.g.  GITHUB_TOKEN=ghp_xxx $0" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
INSTALLER="dist/Fusion Flix Clip Renamer & Sorter Setup.exe"
ASSET_NAME="Fusion Flix Clip Renamer & Sorter Setup.exe"
TAG="v$VERSION"
TITLE="Fusion Flix — Clip Renamer & Sorter $VERSION"
NOTES_FILE="RELEASE-NOTES-v$VERSION.md"

echo "▸ version  : $VERSION  (tag $TAG)"
echo "▸ repo     : $OWNER/$REPO  (branch $BRANCH)"

# --------------------------------------------------------------------- 1+2 --
if [ ! -d .git ]; then
  git init -q
  git symbolic-ref HEAD "refs/heads/$BRANCH"
fi
git add -A
if git diff --cached --quiet; then
  echo "▸ nothing new to commit"
else
  git -c user.name="Dhruv Sharma" -c user.email="dhruv@fusionflix.local" \
      commit -q -m "Fusion Flix — Clip Renamer & Sorter $VERSION"
  echo "▸ committed"
fi
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$OWNER/$REPO.git"

# The token is used for this push only (never written to .git/config).
git -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')" \
    push origin "$BRANCH" --force-with-lease 2>/dev/null \
  || git -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')" \
    push origin "$BRANCH"
echo "▸ pushed to $BRANCH"

# ----------------------------------------------------------------------- 3 --
api() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }

BODY="$(python3 - "$NOTES_FILE" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
text = p.read_text(encoding='utf-8') if p.exists() else 'See CHANGELOG.md.'
print(json.dumps({"tag_name": "@@TAG@@", "name": "@@TITLE@@", "body": text, "draft": False, "prerelease": False}))
PY
)"
BODY="${BODY//@@TAG@@/$TAG}"
BODY="${BODY//@@TITLE@@/$TITLE}"

RELEASE_JSON="$(api -X POST "https://api.github.com/repos/$OWNER/$REPO/releases" -d "$BODY" || true)"
UPLOAD_URL="$(printf '%s' "$RELEASE_JSON" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("upload_url","").split("{")[0])' 2>/dev/null || true)"

if [ -z "$UPLOAD_URL" ]; then
  echo "▸ release $TAG already exists — reusing it"
  UPLOAD_URL="$(api "https://api.github.com/repos/$OWNER/$REPO/releases/tags/$TAG" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("upload_url","").split("{")[0])')"
fi

# ----------------------------------------------------------------------- 4 --
if [ ! -f "$INSTALLER" ]; then
  echo "error: $INSTALLER not found — run 'npm run build:win' first." >&2
  exit 1
fi

echo "▸ uploading $(du -h "$INSTALLER" | cut -f1) installer…"
api -X POST "$UPLOAD_URL?name=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$ASSET_NAME")" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$INSTALLER" >/dev/null

echo "✔ done: https://github.com/$OWNER/$REPO/releases/tag/$TAG"
