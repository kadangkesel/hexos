#!/bin/bash
# Hexos Installer
# Usage: curl -fsSL https://hexos.kadangkesel.net/install | bash
#
# Environment variables:
#   HEXOS_VERSION   - Specific version to install (default: latest)
#   HEXOS_DIR       - Installation directory (default: ~/.hexos)
#   HEXOS_NO_MODIFY_PATH - Set to 1 to skip PATH modification
#   GITHUB_REPO     - GitHub repository (default: kadangkesel/hexos)

set -euo pipefail

# Configuration
GITHUB_REPO="${GITHUB_REPO:-kadangkesel/hexos}"
BASE_URL="https://hexos.kadangkesel.net"
HEXOS_DIR="${HEXOS_DIR:-$HOME/.hexos}"
BIN_DIR="$HEXOS_DIR/bin"
LINK_DIR="$HOME/.local/bin"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

info() { echo -e "${CYAN}==>${NC} $1"; }
ok() { echo -e "${GREEN}==>${NC} $1"; }
warn() { echo -e "${YELLOW}==>${NC} $1"; }
err() { echo -e "${RED}==>${NC} $1" >&2; }

# Detect platform
detect_platform() {
  local os arch

  case "$(uname -s)" in
    Linux*)  os="linux" ;;
    Darwin*) os="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *)
      err "Unsupported OS: $(uname -s)"
      err "For Windows, use: irm $BASE_URL/install.ps1 | iex"
      exit 1
      ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      err "Unsupported architecture: $(uname -m)"
      exit 1
      ;;
  esac

  echo "${os}/${arch}"
}

# Fetch latest version
get_latest_version() {
  local version=""

  # Try custom domain first (lightweight, no GitHub API rate limit)
  local custom_url="${BASE_URL}/version"
  if command -v curl &>/dev/null; then
    version=$(curl -fsSL "$custom_url" 2>/dev/null | tr -d '[:space:]')
  elif command -v wget &>/dev/null; then
    version=$(wget -qO- "$custom_url" 2>/dev/null | tr -d '[:space:]')
  fi

  # Fallback to GitHub API
  if [ -z "$version" ]; then
    local gh_url="https://api.github.com/repos/$GITHUB_REPO/releases/latest"
    if command -v curl &>/dev/null; then
      version=$(curl -fsSL "$gh_url" 2>/dev/null | grep '"tag_name"' | head -1 | sed 's/.*"v\?\([^"]*\)".*/\1/')
    elif command -v wget &>/dev/null; then
      version=$(wget -qO- "$gh_url" 2>/dev/null | grep '"tag_name"' | head -1 | sed 's/.*"v\?\([^"]*\)".*/\1/')
    else
      err "Neither curl nor wget found. Please install one of them."
      exit 1
    fi
  fi

  if [ -z "$version" ]; then
    err "Failed to fetch latest version"
    exit 1
  fi

  echo "$version"
}

# Download file
download() {
  local url="$1"
  local dest="$2"

  if command -v curl &>/dev/null; then
    curl -fsSL -o "$dest" "$url"
  elif command -v wget &>/dev/null; then
    wget -qO "$dest" "$url"
  fi
}

# Verify checksum
verify_checksum() {
  local file="$1"
  local expected="$2"

  local actual
  if command -v sha256sum &>/dev/null; then
    actual=$(sha256sum "$file" | awk '{print $1}')
  elif command -v shasum &>/dev/null; then
    actual=$(shasum -a 256 "$file" | awk '{print $1}')
  else
    warn "No sha256sum or shasum found — skipping checksum verification"
    return 0
  fi

  if [ "$actual" != "$expected" ]; then
    err "Checksum mismatch!"
    err "  Expected: $expected"
    err "  Got:      $actual"
    return 1
  fi
}

# Add to PATH
setup_path() {
  if [ "${HEXOS_NO_MODIFY_PATH:-0}" = "1" ]; then
    return
  fi

  # Create link directory
  mkdir -p "$LINK_DIR"

  # Create symlink
  ln -sf "$BIN_DIR/hexos" "$LINK_DIR/hexos"

  # Check if LINK_DIR is in PATH
  if echo "$PATH" | tr ':' '\n' | grep -qx "$LINK_DIR"; then
    return
  fi

  # Detect shell and add to PATH
  local shell_rc=""
  local shell_name=$(basename "$SHELL" 2>/dev/null || echo "bash")

  case "$shell_name" in
    zsh)  shell_rc="$HOME/.zshrc" ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        shell_rc="$HOME/.bashrc"
      elif [ -f "$HOME/.bash_profile" ]; then
        shell_rc="$HOME/.bash_profile"
      fi
      ;;
    fish) shell_rc="$HOME/.config/fish/config.fish" ;;
  esac

  if [ -n "$shell_rc" ]; then
    local path_line="export PATH=\"$LINK_DIR:\$PATH\""
    if [ "$shell_name" = "fish" ]; then
      path_line="set -gx PATH $LINK_DIR \$PATH"
    fi

    if ! grep -q "hexos" "$shell_rc" 2>/dev/null; then
      echo "" >> "$shell_rc"
      echo "# Hexos" >> "$shell_rc"
      echo "$path_line" >> "$shell_rc"
      info "Added $LINK_DIR to PATH in $shell_rc"
    fi
  fi
}

main() {
  local start_time=$(date +%s)

  echo ""
  echo -e "${BOLD}  Hexos Installer${NC}"
  echo ""

  # Detect platform
  local platform
  platform=$(detect_platform)
  local os=$(echo "$platform" | cut -d/ -f1)
  local arch=$(echo "$platform" | cut -d/ -f2)
  info "Platform: $platform"

  # Get version
  local version="${HEXOS_VERSION:-}"
  if [ -z "$version" ]; then
    info "Fetching release information..."
    version=$(get_latest_version)
  fi
  info "Version: $version"

  # Construct download URL (via custom domain, proxied to GitHub Releases)
  local archive_name="hexos-${version}-${os}-${arch}.tar.gz"
  local download_url="${BASE_URL}/download/v${version}/${archive_name}"
  local checksum_url="${BASE_URL}/download/v${version}/hexos-${version}-checksums.txt"

  # Create temp directory
  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf $tmp_dir" EXIT

  # Download archive
  info "Downloading hexos $version..."
  download "$download_url" "$tmp_dir/$archive_name"

  # Download and verify checksum
  info "Verifying checksum..."
  if download "$checksum_url" "$tmp_dir/checksums.txt" 2>/dev/null; then
    local expected_hash
    expected_hash=$(grep "$archive_name" "$tmp_dir/checksums.txt" | awk '{print $1}')
    if [ -n "$expected_hash" ]; then
      verify_checksum "$tmp_dir/$archive_name" "$expected_hash"
      ok "Checksum verified"
    else
      warn "Checksum not found for $archive_name — skipping verification"
    fi
  else
    warn "Could not download checksums — skipping verification"
  fi

  # Extract
  info "Extracting..."
  mkdir -p "$HEXOS_DIR"
  mkdir -p "$BIN_DIR"

  tar xzf "$tmp_dir/$archive_name" -C "$tmp_dir/extracted" 2>/dev/null || {
    mkdir -p "$tmp_dir/extracted"
    tar xzf "$tmp_dir/$archive_name" -C "$tmp_dir/extracted"
  }

  # Install binary
  local binary_src="$tmp_dir/extracted/hexos"
  if [ ! -f "$binary_src" ]; then
    # Try finding it recursively
    binary_src=$(find "$tmp_dir/extracted" -name "hexos" -type f | head -1)
  fi

  if [ -z "$binary_src" ] || [ ! -f "$binary_src" ]; then
    err "Binary not found in archive"
    exit 1
  fi

  cp "$binary_src" "$BIN_DIR/hexos"
  chmod +x "$BIN_DIR/hexos"

  # Install dashboard
  local dashboard_src="$tmp_dir/extracted/dashboard"
  if [ -d "$dashboard_src" ]; then
    # Remove old dashboard
    rm -rf "$HEXOS_DIR/dashboard"
    cp -r "$dashboard_src" "$HEXOS_DIR/dashboard"
    info "Dashboard installed"
  fi

  # Install automation scripts
  local automation_src="$tmp_dir/extracted/automation"
  if [ -d "$automation_src" ]; then
    mkdir -p "$HEXOS_DIR/automation"
    cp -r "$automation_src/"* "$HEXOS_DIR/automation/"
    info "Automation scripts installed"
  fi

  # Setup PATH
  info "Setting up PATH..."
  setup_path
  ok "Installed to: $BIN_DIR/hexos"
  ok "Entry point: $LINK_DIR/hexos"

  # Calculate elapsed time
  local end_time=$(date +%s)
  local elapsed=$((end_time - start_time))

  echo ""
  ok "Successfully installed hexos $version! (${elapsed}s)"
  echo ""
  echo -e "  ${BOLD}Quick start:${NC}"
  echo -e "    ${CYAN}hexos start${NC}              Start the proxy server"
  echo -e "    ${CYAN}hexos key create${NC}         Generate an API key"
  echo -e "    ${CYAN}hexos auth connect${NC}       Add a provider account"
  echo ""
  echo -e "  ${BOLD}Dashboard:${NC}"
  echo -e "    Open ${CYAN}http://localhost:7470${NC} after starting the server"
  echo ""
  echo -e "  ${BOLD}Browser automation (optional):${NC}"
  echo -e "    ${CYAN}hexos auth setup-automation${NC}   Install Python + Camoufox"
  echo ""

  # Remind to reload shell if PATH was modified
  if ! command -v hexos &>/dev/null; then
    warn "Restart your shell or run: source ~/.$(basename $SHELL)rc"
  fi
}

main "$@"
