#!/usr/bin/env python3
"""
Hexos Automation Setup
Automatically creates a Python virtual environment and installs dependencies
for browser automation via Camoufox.

Usage:
    python src/automation/setup.py
"""

import os
import subprocess
import sys
from pathlib import Path

AUTOMATION_DIR = Path(__file__).parent
VENV_DIR = AUTOMATION_DIR / ".venv"
REQUIREMENTS_FILE = AUTOMATION_DIR / "requirements.txt"


def emit(message: str, level: str = "info"):
    prefix = {"info": "[*]", "ok": "[+]", "error": "[-]", "warn": "[!]"}
    print(f"{prefix.get(level, '[*]')} {message}", flush=True)


def find_python() -> str:
    """Find a suitable Python 3.10+ executable."""
    candidates = ["python3", "python", "python3.12", "python3.11", "python3.10"]
    if sys.platform == "win32":
        candidates = ["python", "python3", "py -3"]

    for cmd in candidates:
        try:
            parts = cmd.split()
            result = subprocess.run(
                [*parts, "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                version_str = result.stdout.strip() or result.stderr.strip()
                # Parse "Python 3.x.y"
                version_parts = version_str.split()[-1].split(".")
                major, minor = int(version_parts[0]), int(version_parts[1])
                if major >= 3 and minor >= 10:
                    emit(f"Found {version_str} via '{cmd}'")
                    return parts[0] if len(parts) == 1 else cmd
        except Exception:
            continue

    emit("Python 3.10+ not found. Please install Python first.", "error")
    sys.exit(1)


def create_venv(python_cmd: str):
    """Create virtual environment."""
    if VENV_DIR.exists():
        emit(f"Virtual environment already exists at {VENV_DIR}", "warn")
        return

    emit(f"Creating virtual environment at {VENV_DIR}...")
    parts = python_cmd.split()
    subprocess.run(
        [*parts, "-m", "venv", str(VENV_DIR)],
        check=True,
    )
    emit("Virtual environment created", "ok")


def get_venv_python() -> str:
    """Get the Python executable inside the venv."""
    if sys.platform == "win32":
        return str(VENV_DIR / "Scripts" / "python.exe")
    return str(VENV_DIR / "bin" / "python")


def get_venv_pip() -> str:
    """Get the pip executable inside the venv."""
    if sys.platform == "win32":
        return str(VENV_DIR / "Scripts" / "pip.exe")
    return str(VENV_DIR / "bin" / "pip")


def install_dependencies():
    """Install Python dependencies from requirements.txt."""
    pip = get_venv_pip()
    python = get_venv_python()

    emit("Upgrading pip...")
    subprocess.run(
        [python, "-m", "pip", "install", "--upgrade", "pip"],
        check=True,
        capture_output=True,
    )

    emit(f"Installing dependencies from {REQUIREMENTS_FILE}...")
    result = subprocess.run(
        [pip, "install", "-r", str(REQUIREMENTS_FILE)],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        emit(f"Failed to install dependencies:\n{result.stderr}", "error")
        sys.exit(1)

    emit("Dependencies installed", "ok")


def install_playwright_browsers():
    """Install Playwright browser (Firefox for Camoufox)."""
    python = get_venv_python()

    emit("Installing Camoufox browser (this may take a few minutes)...")
    result = subprocess.run(
        [python, "-c", "import camoufox; camoufox.sync_api.CamoufoxSync"],
        capture_output=True,
        text=True,
    )

    # Camoufox handles its own browser download on first use,
    # but we also need playwright's Firefox
    result = subprocess.run(
        [python, "-m", "playwright", "install", "firefox"],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        emit(f"Playwright browser install warning: {result.stderr}", "warn")
    else:
        emit("Browser installed", "ok")


def verify_installation():
    """Verify that all dependencies are importable."""
    python = get_venv_python()

    emit("Verifying installation...")
    result = subprocess.run(
        [
            python,
            "-c",
            "import camoufox; import playwright; import aiohttp; print('All imports OK')",
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        emit(f"Verification failed:\n{result.stderr}", "error")
        sys.exit(1)

    emit(result.stdout.strip(), "ok")


def main():
    emit("=== Hexos Automation Setup ===")
    emit(f"Automation dir: {AUTOMATION_DIR}")

    python_cmd = find_python()
    create_venv(python_cmd)
    install_dependencies()
    install_playwright_browsers()
    verify_installation()

    emit("=== Setup complete! ===", "ok")
    emit(f"Python venv: {VENV_DIR}")
    emit(f"Python binary: {get_venv_python()}")
    emit("You can now use: hexos auth auto-connect / hexos auth batch-connect")


if __name__ == "__main__":
    main()
