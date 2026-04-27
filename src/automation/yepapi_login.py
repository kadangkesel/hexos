#!/usr/bin/env python3
"""
Hexos YepAPI Browser Automation Login
Automates YepAPI login via Google OAuth using Camoufox, then generates an API key.

Usage:
    python yepapi_login.py --email user@gmail.com --password secret

Output (JSON lines on stdout):
    {"type": "progress", "step": "...", "message": "..."}
    {"type": "result", "success": true, "apiKey": "yep_sk_..."}
    {"type": "error", "error": "..."}
"""

import argparse
import asyncio
import json
import os
import sys
import time
from urllib.parse import urlparse

YEPAPI_LOGIN_URL = "https://www.yepapi.com/login"
YEPAPI_DASHBOARD_KEYS = "https://www.yepapi.com/dashboard/api-keys"
AUTH_LOOP_MAX = 90
DEBUG = os.getenv("HEXOS_DEBUG", "false").lower() == "true"


def emit(data: dict):
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        pass


def debug(msg: str):
    if DEBUG:
        emit({"type": "debug", "message": msg})


def progress(step: str, message: str):
    emit({"type": "progress", "step": step, "message": message})


def error(msg: str):
    emit({"type": "error", "error": msg})


def result(success: bool, api_key: str = "", err: str = ""):
    d: dict = {"type": "result", "success": success}
    if api_key:
        d["apiKey"] = api_key
    if err:
        d["error"] = err
    emit(d)


# ---------------------------------------------------------------------------
# Google OAuth helpers
# ---------------------------------------------------------------------------

async def _wait_for_email_transition(page) -> bool:
    try:
        await page.wait_for_function("""() => {
            const host = window.location.host || '';
            const visible = (sels) => sels.some(s =>
                Array.from(document.querySelectorAll(s)).some(e => e.offsetParent !== null));
            const hasEmail = visible(['#identifierId', 'input[name="identifier"]', 'input[type="email"]']);
            const hasPassword = visible(['input[name="Passwd"]', 'input[type="password"]']);
            if (!host.includes('accounts.google.com')) return true;
            if (hasPassword) return true;
            return !hasEmail;
        }""", timeout=10000)
        return True
    except Exception:
        return False


async def _wait_for_password_transition(page) -> bool:
    try:
        await page.wait_for_function("""() => {
            const host = window.location.host || '';
            const path = window.location.pathname || '';
            const hasPassword = Array.from(
                document.querySelectorAll('input[name="Passwd"], input[type="password"]')
            ).some(e => e.offsetParent !== null);
            if (!host.includes('accounts.google.com')) return true;
            if (!path.includes('/challenge/pwd')) return true;
            return !hasPassword;
        }""", timeout=12000)
        return True
    except Exception:
        return False


async def is_email_step(page) -> bool:
    try:
        return bool(await page.evaluate("""() => {
            for (const el of document.querySelectorAll('#identifierId, input[type="email"], input[name="identifier"]')) {
                if (el.offsetParent !== null) return true;
            }
            return false;
        }"""))
    except Exception:
        return False


async def is_password_step(page) -> bool:
    try:
        return bool(await page.evaluate("""() => {
            for (const el of document.querySelectorAll('input[name="Passwd"], input[type="password"]')) {
                if (el.offsetParent !== null) return true;
            }
            return false;
        }"""))
    except Exception:
        return False


async def click_google_next(page) -> bool:
    try:
        return bool(await page.evaluate("""() => {
            const btn = document.querySelector('#identifierNext button, #passwordNext button');
            if (btn && btn.offsetParent !== null) { btn.click(); return true; }
            for (const el of document.querySelectorAll('div.VfPpkd-RLmnJb, button, div[role="button"]')) {
                const p = el.closest('button, div[role="button"]') || el;
                if (p && p.offsetParent !== null) { p.click(); return true; }
            }
            return false;
        }"""))
    except Exception:
        return False


async def fill_email(page, email: str) -> bool:
    try:
        await page.wait_for_selector("#identifierId", state="visible", timeout=3000)
    except Exception:
        pass
    loc = page.locator("#identifierId").first
    try:
        if await loc.count() == 0 or not await loc.is_visible():
            return False
        await loc.scroll_into_view_if_needed()
        await loc.click(force=True)
        await asyncio.sleep(0.2)
        await loc.press("Control+a")
        await loc.press("Backspace")
        await loc.press_sequentially(email, delay=60)
        await asyncio.sleep(0.5)
        val = await loc.input_value()
        if email.lower() != str(val).lower().strip():
            return False
        if not await click_google_next(page):
            await loc.press("Enter")
        await _wait_for_email_transition(page)
        return True
    except Exception:
        return False


async def fill_password(page, password: str) -> bool:
    for selector in ['input[name="Passwd"]', 'input[type="password"]']:
        try:
            await page.wait_for_selector(selector, state="visible", timeout=3000)
        except Exception:
            pass
        loc = page.locator(selector).first
        try:
            if await loc.count() == 0 or not await loc.is_visible():
                continue
            await loc.scroll_into_view_if_needed()
            await loc.click(force=True)
            await asyncio.sleep(0.2)
            await loc.press("Control+a")
            await loc.press("Backspace")
            await loc.press_sequentially(password, delay=70)
            await asyncio.sleep(0.5)
            if not await click_google_next(page):
                await loc.press("Enter")
            await _wait_for_password_transition(page)
            return True
        except Exception:
            continue
    return False


async def handle_gaplustos(page) -> bool:
    try:
        url = page.url
    except Exception:
        return False
    if "/speedbump/gaplustos" not in url:
        return False
    try:
        await page.wait_for_selector(
            '#confirm, input[name="confirm"], input[type="submit"]',
            state="visible", timeout=5000,
        )
    except Exception:
        pass
    for sel in ["#confirm", 'input[name="confirm"]', 'input[type="submit"]']:
        loc = page.locator(sel).first
        try:
            if await loc.count() > 0 and await loc.is_visible():
                await loc.click(force=True)
                return True
        except Exception:
            continue
    try:
        return bool(await page.evaluate("""() => {
            for (const el of document.querySelectorAll('input[type="submit"], button')) {
                if (!el || el.offsetParent === null) continue;
                const txt = (el.value || el.textContent || '').toLowerCase();
                if (txt.includes('agree') || txt.includes('understand') || txt.includes('confirm') || txt.includes('mengerti')) {
                    el.click(); return true;
                }
            }
            return false;
        }"""))
    except Exception:
        return False


async def handle_consent(page) -> bool:
    try:
        url = page.url
    except Exception:
        return False
    if "accounts.google.com" not in url:
        return False
    if "/signin/oauth" not in url and "/consent" not in url:
        return False
    try:
        clicked = await page.evaluate("""() => {
            for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                const txt = (btn.textContent || '').trim().toLowerCase();
                if (!txt || btn.offsetParent === null) continue;
                if (txt === 'continue' || txt.includes('allow') || txt.includes('lanjut')) {
                    btn.click(); return true;
                }
            }
            const submits = document.querySelectorAll('input[type="submit"], button[type="submit"]');
            for (const btn of submits) {
                if (btn.offsetParent !== null) { btn.click(); return true; }
            }
            return false;
        }""")
        if clicked:
            await asyncio.sleep(2)
        return bool(clicked)
    except Exception:
        return False


async def click_continue(page):
    try:
        await page.evaluate("""() => {
            const kw = ['next','continue','accept','i understand','agree','ok','got it','login','sign in'];
            for (const btn of document.querySelectorAll('button, div[role="button"], input[type="submit"]')) {
                const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
                if (txt && kw.some(k => txt.includes(k)) && btn.offsetParent !== null) { btn.click(); return; }
            }
        }""")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

async def run(email: str, password: str):
    progress("init", "Starting Camoufox browser...")

    try:
        from browserforge.fingerprints import Screen
        from camoufox.async_api import AsyncCamoufox
    except ImportError as e:
        error(f"Missing dependency: {e}. Run: hexos auth setup-automation")
        return

    headless = os.getenv("HEXOS_HEADLESS", "true").lower() == "true"
    proxy_url = os.getenv("HEXOS_PROXY", "")

    camoufox_kwargs = {
        "headless": headless,
        "os": "windows",
        "block_webrtc": True,
        "humanize": False,
        "screen": Screen(max_width=1920, max_height=1080),
    }

    if proxy_url:
        parsed = urlparse(proxy_url)
        proxy_cfg = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
        if parsed.username:
            proxy_cfg["username"] = parsed.username
        if parsed.password:
            proxy_cfg["password"] = parsed.password
        camoufox_kwargs["proxy"] = proxy_cfg
        camoufox_kwargs["geoip"] = True

    manager = AsyncCamoufox(**camoufox_kwargs)
    browser = await manager.__aenter__()

    try:
        page = await browser.new_page()
        page.set_default_timeout(30000)

        # Step 1: Navigate to YepAPI login
        progress("navigate", "Opening YepAPI login page...")
        await page.goto(YEPAPI_LOGIN_URL, wait_until="domcontentloaded", timeout=20000)
        await asyncio.sleep(2)

        # Step 2: Click Google login button
        progress("google_click", "Clicking Google login button...")
        try:
            await page.locator('button:has-text("Google")').first.click(timeout=5000)
        except Exception:
            # Fallback: look for any Google-related login link/button
            await page.locator('a:has-text("Google"), button:has-text("Sign in with Google"), [data-provider="google"]').first.click(timeout=5000)
        await asyncio.sleep(3)

        # Step 3: Google OAuth flow
        progress("google_auth", "Authenticating with Google...")
        email_deadline = 0.0
        pw_deadline = 0.0

        for _ in range(AUTH_LOOP_MAX):
            try:
                url = page.url
            except Exception:
                error("Browser page lost during authentication")
                return

            host = urlparse(url).netloc
            path = urlparse(url).path

            # Check if we reached YepAPI dashboard
            if "yepapi.com" in host and "/dashboard" in path:
                progress("authenticated", "Reached YepAPI dashboard")
                break

            if "SetSID" in url or "/accounts/set" in url.lower():
                await asyncio.sleep(0.5)
                continue

            if await handle_gaplustos(page):
                debug("Accepted Google TOS")
                await asyncio.sleep(0.8)
                continue

            if await handle_consent(page):
                debug("Accepted OAuth consent")
                await asyncio.sleep(0.8)
                continue

            if "accounts.google.com" in host:
                now = time.monotonic()
                at_pw = await is_password_step(page)
                at_email = await is_email_step(page)

                if at_email and not at_pw:
                    if now < email_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await fill_email(page, email):
                        progress("email", "Entered email")
                        email_deadline = time.monotonic() + 6.0
                        await asyncio.sleep(1.0)
                        continue

                if at_pw:
                    if now < pw_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await fill_password(page, password):
                        progress("password", "Entered password")
                        pw_deadline = time.monotonic() + 8.0
                        await asyncio.sleep(1.0)
                        continue

                if at_email or at_pw:
                    await asyncio.sleep(0.6)
                    continue

            await click_continue(page)
            await asyncio.sleep(1.0)
        else:
            error("OAuth flow timed out — did not reach YepAPI dashboard")
            return

        # Step 4: Navigate to API keys page and generate key
        progress("keygen", "Navigating to API keys page...")
        key_name = email.split("@")[0].lower()[:20]

        await page.goto(YEPAPI_DASHBOARD_KEYS, wait_until="domcontentloaded", timeout=20000)
        await asyncio.sleep(3)

        progress("keygen", "Creating new API key...")

        # Click Create/Generate/New/Add button
        create_btn = page.locator(
            'button:has-text("Create"), button:has-text("Generate"), '
            'button:has-text("New"), button:has-text("Add")'
        )
        try:
            await create_btn.first.click(timeout=5000)
            await asyncio.sleep(1)
        except Exception:
            debug("No create button found, trying to find key on page directly")

        # Fill key name if input is visible
        name_input = page.locator(
            'input[placeholder*="name" i], input[placeholder*="label" i], '
            'input[placeholder*="key" i], input[type="text"]'
        )
        try:
            if await name_input.first.is_visible(timeout=3000):
                await name_input.first.fill(key_name)
                await asyncio.sleep(0.5)
        except Exception:
            pass

        # Submit
        submit = page.locator(
            'button:has-text("Create"), button:has-text("Generate"), button[type="submit"]'
        )
        try:
            await submit.first.click(timeout=5000)
            await asyncio.sleep(3)
        except Exception:
            pass

        # Extract API key from page content
        content = await page.content()
        if "yep_sk_" in content:
            start = content.index("yep_sk_")
            end = len(content)
            for ch in ['"', "'", "<", ",", "}", "\n", " "]:
                pos = content.find(ch, start)
                if 0 < pos < end:
                    end = pos
            api_key = content[start:end]
            if len(api_key) > 20:
                progress("done", f"Generated API key: {api_key[:12]}...")
                result(True, api_key=api_key)
                return

        error("Failed to generate API key — yep_sk_ not found in page")

    except Exception as exc:
        error(f"Unexpected error: {exc}")
    finally:
        try:
            await manager.__aexit__(None, None, None)
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="YepAPI browser automation login")
    parser.add_argument("--email", required=True, help="Google account email")
    parser.add_argument("--password", required=True, help="Google account password")
    args = parser.parse_args()

    asyncio.run(run(args.email, args.password))


if __name__ == "__main__":
    main()
