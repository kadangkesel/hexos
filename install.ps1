# Hexos Installer for Windows
# Usage: irm https://hexos.kadangkesel.net/install.ps1 | iex
#
# Environment variables:
#   $env:HEXOS_VERSION   - Specific version to install (default: latest)
#   $env:HEXOS_DIR       - Installation directory (default: ~/.hexos)
#   $env:GITHUB_REPO     - GitHub repository (default: kadangkesel/hexos)

$ErrorActionPreference = "Stop"

# Configuration
$GithubRepo = if ($env:GITHUB_REPO) { $env:GITHUB_REPO } else { "kadangkesel/hexos" }
$BaseUrl = "https://hexos.kadangkesel.net"
$HexosDir = if ($env:HEXOS_DIR) { $env:HEXOS_DIR } else { Join-Path $HOME ".hexos" }
$BinDir = Join-Path $HexosDir "bin"

function Write-Info($msg) { Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $msg }
function Write-Ok($msg) { Write-Host "==> " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Write-Warn($msg) { Write-Host "==> " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Err($msg) { Write-Host "==> " -ForegroundColor Red -NoNewline; Write-Host $msg }

function Get-LatestVersion {
    # Try custom domain first (lightweight, no GitHub API rate limit)
    try {
        $version = (Invoke-WebRequest -Uri "$BaseUrl/version" -UseBasicParsing).Content.Trim()
        if ($version) { return $version }
    }
    catch {}

    # Fallback to GitHub API
    $url = "https://api.github.com/repos/$GithubRepo/releases/latest"
    try {
        $response = Invoke-RestMethod -Uri $url -UseBasicParsing
        $version = $response.tag_name -replace '^v', ''
        return $version
    }
    catch {
        Write-Err "Failed to fetch latest version"
        exit 1
    }
}

function Get-Checksum($filePath) {
    $hash = Get-FileHash -Path $filePath -Algorithm SHA256
    return $hash.Hash.ToLower()
}

function Add-ToPath($dir) {
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -split ";" | Where-Object { $_ -eq $dir }) {
        return $false
    }
    [Environment]::SetEnvironmentVariable("Path", "$dir;$currentPath", "User")
    $env:Path = "$dir;$env:Path"
    return $true
}

function Main {
    $startTime = Get-Date

    Write-Host ""
    Write-Host "  Hexos Installer" -ForegroundColor White
    Write-Host ""

    # Detect platform
    $arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
    $platform = "windows/$arch"
    Write-Info "Platform: $platform"

    # Get version
    $version = $env:HEXOS_VERSION
    if (-not $version) {
        Write-Info "Fetching release information..."
        $version = Get-LatestVersion
    }
    Write-Info "Version: $version"

    # Construct download URL (via custom domain, proxied to GitHub Releases)
    $archiveName = "hexos-$version-windows-$arch.zip"
    $downloadUrl = "$BaseUrl/download/v$version/$archiveName"
    $checksumUrl = "$BaseUrl/download/v$version/hexos-$version-checksums.txt"

    # Create temp directory
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "hexos-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    try {
        # Download archive
        Write-Info "Downloading hexos $version..."
        $archivePath = Join-Path $tmpDir $archiveName
        Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing

        # Download and verify checksum
        Write-Info "Verifying checksum..."
        try {
            $checksumPath = Join-Path $tmpDir "checksums.txt"
            Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath -UseBasicParsing
            $checksumContent = Get-Content $checksumPath
            $expectedLine = $checksumContent | Where-Object { $_ -match $archiveName }
            if ($expectedLine) {
                $expectedHash = ($expectedLine -split "\s+")[0]
                $actualHash = Get-Checksum $archivePath
                if ($actualHash -ne $expectedHash) {
                    Write-Err "Checksum mismatch!"
                    Write-Err "  Expected: $expectedHash"
                    Write-Err "  Got:      $actualHash"
                    exit 1
                }
                Write-Ok "Checksum verified"
            }
            else {
                Write-Warn "Checksum not found for $archiveName"
            }
        }
        catch {
            Write-Warn "Could not download checksums - skipping verification"
        }

        # Extract
        Write-Info "Extracting..."
        $extractDir = Join-Path $tmpDir "extracted"
        Expand-Archive -Path $archivePath -DestinationPath $extractDir -Force

        # Create directories
        New-Item -ItemType Directory -Path $HexosDir -Force | Out-Null
        New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

        # Install binary
        $binarySrc = Join-Path $extractDir "hexos.exe"
        if (-not (Test-Path $binarySrc)) {
            # Try finding it recursively
            $binarySrc = Get-ChildItem -Path $extractDir -Filter "hexos.exe" -Recurse | Select-Object -First 1 -ExpandProperty FullName
        }
        if (-not $binarySrc -or -not (Test-Path $binarySrc)) {
            Write-Err "Binary not found in archive"
            exit 1
        }
        Copy-Item $binarySrc (Join-Path $BinDir "hexos.exe") -Force

        # Install dashboard
        $dashboardSrc = Join-Path $extractDir "dashboard"
        if (Test-Path $dashboardSrc) {
            $dashboardDest = Join-Path $HexosDir "dashboard"
            if (Test-Path $dashboardDest) { Remove-Item $dashboardDest -Recurse -Force }
            Copy-Item $dashboardSrc $dashboardDest -Recurse
            Write-Info "Dashboard installed"
        }

        # Install automation scripts
        $automationSrc = Join-Path $extractDir "automation"
        if (Test-Path $automationSrc) {
            $automationDest = Join-Path $HexosDir "automation"
            New-Item -ItemType Directory -Path $automationDest -Force | Out-Null
            Copy-Item "$automationSrc\*" $automationDest -Recurse -Force
            Write-Info "Automation scripts installed"
        }

        # Add to PATH
        Write-Info "Setting up PATH..."
        $pathAdded = Add-ToPath $BinDir
        Write-Ok "Installed to: $BinDir\hexos.exe"

        # Calculate elapsed time
        $elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)

        Write-Host ""
        Write-Ok "Successfully installed hexos $version! (${elapsed}s)"
        Write-Host ""
        Write-Host "  Quick start:" -ForegroundColor White
        Write-Host "    hexos start              " -ForegroundColor Cyan -NoNewline; Write-Host "Start the proxy server"
        Write-Host "    hexos key create         " -ForegroundColor Cyan -NoNewline; Write-Host "Generate an API key"
        Write-Host "    hexos auth connect       " -ForegroundColor Cyan -NoNewline; Write-Host "Add a provider account"
        Write-Host ""
        Write-Host "  Dashboard:" -ForegroundColor White
        Write-Host "    Open " -NoNewline; Write-Host "http://localhost:7470" -ForegroundColor Cyan -NoNewline; Write-Host " after starting the server"
        Write-Host ""
        Write-Host "  Browser automation (optional):" -ForegroundColor White
        Write-Host "    hexos auth setup-automation" -ForegroundColor Cyan -NoNewline; Write-Host "   Install Python + Camoufox"
        Write-Host ""

        if ($pathAdded) {
            Write-Warn "Restart your terminal for PATH changes to take effect"
        }
    }
    finally {
        # Cleanup
        Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Main
