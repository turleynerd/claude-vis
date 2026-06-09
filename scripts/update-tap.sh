#!/usr/bin/env bash
# Bump the Homebrew tap formula to a released version of claude-vis.
#
# usage: scripts/update-tap.sh [vX.Y.Z]   (default: latest GitHub release)
#
# Downloads checksums.txt from the release, renders Formula/claude-vis.rb,
# and pushes it to turleynerd/homebrew-tap using your local `gh` auth.
set -euo pipefail

REPO=turleynerd/claude-vis
TAP=turleynerd/homebrew-tap

TAG="${1:-$(gh release view --repo "$REPO" --json tagName -q .tagName)}"
VERSION="${TAG#v}"
BASE="https://github.com/$REPO/releases/download/$TAG"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

gh release download "$TAG" --repo "$REPO" --pattern checksums.txt --dir "$work"

sha() {
  awk -v f="./claude-vis-$1.tar.gz" '$2 == f { print $1 }' "$work/checksums.txt"
}
for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  [ -n "$(sha "$t")" ] || { echo "missing checksum for $t in $TAG" >&2; exit 1; }
done

git clone --depth 1 "https://github.com/$TAP.git" "$work/tap"
mkdir -p "$work/tap/Formula"
cat > "$work/tap/Formula/claude-vis.rb" <<EOF
class ClaudeVis < Formula
  desc "Animated terminal sprites for your running Claude Code agents"
  homepage "https://github.com/$REPO"
  version "$VERSION"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "$BASE/claude-vis-darwin-arm64.tar.gz"
      sha256 "$(sha darwin-arm64)"
    else
      url "$BASE/claude-vis-darwin-x64.tar.gz"
      sha256 "$(sha darwin-x64)"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "$BASE/claude-vis-linux-arm64.tar.gz"
      sha256 "$(sha linux-arm64)"
    else
      url "$BASE/claude-vis-linux-x64.tar.gz"
      sha256 "$(sha linux-x64)"
    end
  end

  def install
    bin.install "claude-vis"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/claude-vis --version")
  end
end
EOF

cd "$work/tap"
git add Formula/claude-vis.rb
if git diff --cached --quiet; then
  echo "formula already at $VERSION"
  exit 0
fi
git commit -m "claude-vis $VERSION"
git push origin HEAD
echo "tap updated to $VERSION"
