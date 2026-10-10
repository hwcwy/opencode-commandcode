#!/usr/bin/env bash
# Copy the Command Code plugin into the global OpenCode plugin directory.
# OpenCode watches that directory and reloads the plugin automatically.
#
# Works on macOS and Linux (and Git Bash / WSL on Windows).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_file="$script_dir/commandcode.ts"

if [ ! -f "$source_file" ]; then
  echo "Not found: $source_file" >&2
  exit 1
fi

# OpenCode reads its global config from $XDG_CONFIG_HOME/opencode or ~/.config/opencode.
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
target_dir="$config_home/opencode/plugins"
target="$target_dir/commandcode.ts"

mkdir -p "$target_dir"
cp "$source_file" "$target"

echo "Installed: $target"
if command -v sha256sum >/dev/null 2>&1; then
  echo "SHA256:    $(sha256sum "$source_file" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  echo "SHA256:    $(shasum -a 256 "$source_file" | awk '{print $1}')"
fi
echo "OK - OpenCode will hot-reload the plugin."
