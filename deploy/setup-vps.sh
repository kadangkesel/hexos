#!/bin/bash
# Setup script for hexos.kadangkesel.net on VPS
# Run on VPS: bash setup-vps.sh
#
# Prerequisites:
#   - Nginx installed
#   - Certbot installed (apt install certbot python3-certbot-nginx)
#   - DNS A record pointing hexos.kadangkesel.net to VPS IP

set -euo pipefail

DOMAIN="hexos.kadangkesel.net"
WEB_ROOT="/var/www/hexos"
NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"
GITHUB_REPO="kadangkesel/hexos"
GITHUB_RAW="https://raw.githubusercontent.com/$GITHUB_REPO/master"

info() { echo -e "\033[36m==>\033[0m $1"; }
ok() { echo -e "\033[32m==>\033[0m $1"; }
err() { echo -e "\033[31m==>\033[0m $1" >&2; }

# Check root
if [ "$EUID" -ne 0 ]; then
  err "Please run as root (sudo bash setup-vps.sh)"
  exit 1
fi

info "Setting up $DOMAIN..."

# Create web root
mkdir -p "$WEB_ROOT"

# Download installer scripts from GitHub
info "Downloading installer scripts..."
curl -fsSL "$GITHUB_RAW/install.sh" -o "$WEB_ROOT/install.sh"
curl -fsSL "$GITHUB_RAW/install.ps1" -o "$WEB_ROOT/install.ps1"

# Create version file (will be updated by CI/CD or manually)
if [ ! -f "$WEB_ROOT/version" ]; then
  echo "0.1.0" > "$WEB_ROOT/version"
  info "Created version file (0.1.0)"
fi

# Create landing page
if [ ! -f "$WEB_ROOT/index.html" ]; then
  cat > "$WEB_ROOT/index.html" << 'LANDING'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hexos — AI API Proxy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container { max-width: 640px; padding: 2rem; }
    h1 { font-size: 2.5rem; color: #ff7b00; margin-bottom: 0.5rem; }
    .subtitle { color: #888; margin-bottom: 2rem; }
    .install-block {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .install-block h3 { color: #ff7b00; font-size: 0.85rem; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    code {
      display: block;
      background: #111;
      border: 1px solid #2a2a2a;
      border-radius: 4px;
      padding: 0.75rem 1rem;
      color: #4ade80;
      font-size: 0.9rem;
      overflow-x: auto;
      cursor: pointer;
      position: relative;
    }
    code:hover { border-color: #ff7b00; }
    code::after {
      content: 'click to copy';
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 0.7rem;
      color: #555;
    }
    .features { list-style: none; margin-top: 2rem; }
    .features li { padding: 0.4rem 0; color: #aaa; }
    .features li::before { content: '→ '; color: #ff7b00; }
    .footer { margin-top: 2rem; color: #555; font-size: 0.8rem; }
    .footer a { color: #ff7b00; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>hexos</h1>
    <p class="subtitle">Lightweight AI API proxy with multi-provider support</p>

    <div class="install-block">
      <h3>Linux / macOS</h3>
      <code onclick="navigator.clipboard.writeText(this.innerText.replace('click to copy','').trim())">curl -fsSL https://hexos.kadangkesel.net/install | bash</code>
    </div>

    <div class="install-block">
      <h3>Windows (PowerShell)</h3>
      <code onclick="navigator.clipboard.writeText(this.innerText.replace('click to copy','').trim())">irm https://hexos.kadangkesel.net/install.ps1 | iex</code>
    </div>

    <ul class="features">
      <li>Multi-provider: CodeBuddy, Cline, Kiro</li>
      <li>OpenAI-compatible API on localhost:7470</li>
      <li>Built-in dashboard with usage tracking</li>
      <li>Browser automation for batch account setup</li>
      <li>Works with Claude Code, OpenCode, Cline, Hermes</li>
    </ul>

    <div class="footer">
      <a href="https://github.com/kadangkesel/hexos">GitHub</a>
    </div>
  </div>
</body>
</html>
LANDING
  ok "Created landing page"
fi

# Install Nginx config
info "Installing Nginx config..."
cp "$WEB_ROOT/../hexos-nginx.conf" "$NGINX_CONF" 2>/dev/null || {
  # If config file not found locally, create it inline
  cat > "$NGINX_CONF" << 'NGINXCONF'
server {
    listen 80;
    listen [::]:80;
    server_name hexos.kadangkesel.net;

    root /var/www/hexos;
    index index.html;

    location = /install {
        default_type text/plain;
        alias /var/www/hexos/install.sh;
    }

    location = /install.ps1 {
        default_type text/plain;
        alias /var/www/hexos/install.ps1;
    }

    location = /version {
        default_type text/plain;
        alias /var/www/hexos/version;
    }

    location /download/ {
        rewrite ^/download/(.*)$ https://github.com/kadangkesel/hexos/releases/download/$1 redirect;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
NGINXCONF
}

# Enable site
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/ 2>/dev/null || true

# Test Nginx config
info "Testing Nginx config..."
nginx -t

# Reload Nginx
info "Reloading Nginx..."
systemctl reload nginx

ok "Nginx configured for $DOMAIN"

# SSL
info "Setting up SSL with Certbot..."
if command -v certbot &>/dev/null; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@kadangkesel.net || {
    warn "Certbot failed — run manually: certbot --nginx -d $DOMAIN"
  }
else
  warn "Certbot not found. Install: apt install certbot python3-certbot-nginx"
  warn "Then run: certbot --nginx -d $DOMAIN"
fi

echo ""
ok "Setup complete!"
echo ""
echo "  Test: curl -fsSL https://$DOMAIN/install | head -5"
echo "  Update version: echo '0.2.0' > $WEB_ROOT/version"
echo "  Update scripts: curl -fsSL $GITHUB_RAW/install.sh > $WEB_ROOT/install.sh"
echo ""
