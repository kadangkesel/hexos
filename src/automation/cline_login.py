#!/usr/bin/env python3
"""
Hexos Browser Automation – Cline Login
Automates Cline OAuth login via Google using Camoufox (anti-detect browser).

Usage:
    python cline_login.py --email user@gmail.com --password secret

Output (JSON lines on stdout):
    {"type": "progress", "step": "...", "message": "..."}
    {"type": "result", "success": true, "accessToken": "...", "refreshToken": "...", "uid": "...", "email": "...", "credit": {...}}
    {"type": "error", "error": "..."}
"""

import argparse
import asyncio
import base64
import json
import os
import sys
import time
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CLINE_AUTH_URL = (
    "https://api.cline.bot/api/v1/auth/authorize"
    "?client_type=extension"
    "&callback_url=http%3A%2F%2F127.0.0.1%3A48801%2Fauth"
    "&redirect_uri=http%3A%2F%2F127.0.0.1%3A48801%2Fauth"
)
CLINE_API_BASE = "https://api.cline.bot/api/v1"
CALLBACK_HOST = "127.0.0.1:48801"

AUTH_LOOP_MAX_ITERATIONS = 200
DEBUG = os.getenv("HEXOS_DEBUG", "false").lower() == "true"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def emit(data: dict):
    """Emit a JSON line to stdout for the parent process to consume."""
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        pass


def debug(msg: str):
    if DEBUG:
        emit({"type": "debug", "message": msg})


def progress(step: str, message: str):
    emit({"type": "progress", "step": step, "message": message})


def error(message: str):
    emit({"type": "error", "error": message})


def result_success(
    access_token: str,
    refresh_token: str,
    uid: str,
    email: str = "",
    credit: dict | None = None,
):
    data = {
        "type": "result",
        "success": True,
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "uid": uid,
        "email": email,
    }
    if credit:
        data["credit"] = credit
    emit(data)


def result_failure(message: str):
    emit({"type": "result", "success": False, "error": message})


# ---------------------------------------------------------------------------
# Google OAuth form helpers
# Uses page.query_selector() for detection (NOT page.evaluate – it hangs
# in Camoufox).  Typing uses locator.press_sequentially().
# ---------------------------------------------------------------------------


async def _is_email_step(page) -> bool:
    """Detect Google email input step."""
    try:
        for sel in ["#identifierId", 'input[type="email"]', 'input[name="identifier"]']:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                return True
        return False
    except Exception as exc:
        debug(f"_is_email_step error: {exc}")
        return False


async def _is_password_step(page) -> bool:
    """Detect Google password input step."""
    try:
        for sel in ['input[name="Passwd"]', 'input[type="password"]']:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                return True
        return False
    except Exception as exc:
        debug(f"_is_password_step error: {exc}")
        return False


async def _fill_email(page, email: str) -> bool:
    """Fill the Google email field and submit."""
    selectors = [
        "#identifierId",
        'input[type="email"]',
        'input[name="identifier"]',
        'input[autocomplete="username"]',
        'input[autocomplete="email"]',
    ]

    found_selector = None
    for selector in selectors:
        try:
            await page.wait_for_selector(selector, state="visible", timeout=3000)
            found_selector = selector
            break
        except Exception:
            continue

    if not found_selector:
        debug("No email input found")
        return False

    debug(f"Found email field: {found_selector}")

    try:
        locator = page.locator(found_selector).first
        if await locator.count() == 0 or not await locator.is_visible():
            return False

        await locator.scroll_into_view_if_needed()
        await locator.click(force=True)
        await asyncio.sleep(0.2)

        # Clear existing value
        try:
            await locator.press("Control+a")
            await locator.press("Backspace")
        except Exception:
            pass

        await locator.press_sequentially(email, delay=60)
        await asyncio.sleep(0.5)

        # Verify
        val = await locator.input_value()
        if email.lower() != str(val).lower().strip():
            debug(f"Email mismatch: typed={val!r} expected={email!r}")
            return False

        await asyncio.sleep(0.3)

        # Click Next
        clicked = await _click_next(page)
        if not clicked:
            await locator.press("Enter")

        # Wait for transition to password step
        await _wait_for_transition(
            page,
            check_fn="""() => {
                const hasPassword = Array.from(
                    document.querySelectorAll('input[name="Passwd"], input[type="password"]')
                ).some(el => el.offsetParent !== null);
                if (hasPassword) return true;
                const hasEmail = document.querySelector('#identifierId');
                return !hasEmail || hasEmail.offsetParent === null;
            }""",
            timeout=10000,
        )
        return True
    except Exception as exc:
        debug(f"Email fill error: {exc}")
        return False


async def _fill_password(page, password: str) -> bool:
    """Fill the Google password field and submit."""
    selectors = ['input[name="Passwd"]', 'input[type="password"]']
    for selector in selectors:
        try:
            try:
                await page.wait_for_selector(selector, state="visible", timeout=5000)
            except Exception:
                continue

            locator = page.locator(selector).first
            if await locator.count() == 0 or not await locator.is_visible():
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            await locator.press_sequentially(password, delay=70)
            await asyncio.sleep(0.5)

            typed_len = 0
            try:
                val = await locator.input_value()
                typed_len = len(str(val))
            except Exception:
                pass

            if typed_len < len(password):
                debug(f"Password length mismatch: {typed_len} < {len(password)}")
                continue

            clicked = await _click_next(page)
            if not clicked:
                await locator.press("Enter")

            # Wait for transition away from password page
            await _wait_for_transition(
                page,
                check_fn="""() => {
                    const host = window.location.host || '';
                    const path = window.location.pathname || '';
                    const hasPassword = Array.from(
                        document.querySelectorAll('input[name="Passwd"], input[type="password"]')
                    ).some(el => el.offsetParent !== null);
                    if (!host.includes('accounts.google.com')) return true;
                    if (!path.includes('/challenge/pwd')) return true;
                    return !hasPassword;
                }""",
                timeout=12000,
            )
            return True
        except Exception as exc:
            debug(f"Password fill error: {exc}")
            continue
    return False


async def _click_next(page) -> bool:
    """Click the Google Next button (#identifierNext or #passwordNext).

    Uses query_selector instead of page.evaluate() to avoid Camoufox hangs.
    """
    for sel in [
        "#identifierNext button",
        "#passwordNext button",
        "#identifierNext",
        "#passwordNext",
    ]:
        try:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                await el.click()
                return True
        except Exception:
            continue

    # Fallback: get_by_role
    for label in ["Next", "Berikutnya"]:
        try:
            btn = page.get_by_role("button", name=label).first
            if await btn.count() > 0 and await btn.is_visible():
                await btn.click()
                return True
        except Exception:
            continue
    return False


async def _wait_for_transition(page, check_fn: str, timeout: int = 10000):
    """Wait for a page transition using a JS check function."""
    try:
        await page.wait_for_function(check_fn, timeout=timeout)
    except Exception:
        pass


async def _handle_google_consent(page) -> bool:
    """Handle Google consent / continue page."""
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return False

    for text in ["Continue", "Allow", "Lanjutkan", "Izinkan"]:
        try:
            btn = page.get_by_text(text, exact=False).first
            if await btn.count() > 0 and await btn.is_visible():
                await btn.click(force=True)
                return True
        except Exception:
            pass

    for selector in ['button[type="submit"]', '#submit_approve_access']:
        try:
            el = await page.query_selector(selector)
            if el and await el.is_visible():
                await el.click(force=True)
                return True
        except Exception:
            pass

    return False


async def _handle_google_gaplustos(page) -> bool:
    """Handle Google G+ Terms of Service page."""
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "/speedbump/gaplustos" not in current_url:
        return False

    try:
        try:
            await page.wait_for_selector(
                '#confirm, input[name="confirm"], input[type="submit"]',
                state="visible",
                timeout=5000,
            )
        except Exception:
            pass

        for selector in ["#confirm", 'input[name="confirm"]', 'input[type="submit"]']:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0 or not await locator.is_visible():
                    continue
                await locator.click(force=True)
                return True
            except Exception:
                continue

        for text in ["I understand", "Mengerti", "Confirm", "Saya mengerti"]:
            try:
                btn = page.get_by_text(text, exact=False).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click(force=True)
                    return True
            except Exception:
                pass
        return False
    except Exception:
        return False


async def _is_account_picker(page) -> bool:
    """Detect Google account picker page.

    Uses query_selector instead of page.evaluate().
    """
    # If password or email fields are visible, it's NOT the account picker
    if await _is_password_step(page) or await _is_email_step(page):
        return False

    # Look for account picker elements
    for sel in [
        "div[data-identifier]",
        "div[data-email]",
        "li[data-identifier]",
        "div.BHzsHc",
    ]:
        try:
            els = await page.query_selector_all(sel)
            for el in els:
                if el and await el.is_visible():
                    # Check if it contains an email-like text
                    text = await el.text_content() or ""
                    if "@" in text:
                        return True
        except Exception:
            continue
    return False


async def _click_account_in_picker(page, email: str) -> bool:
    """Click the matching account in Google account picker.

    Uses query_selector instead of page.evaluate().
    """
    lower = email.lower()
    for sel in [
        "div[data-identifier]",
        "div[data-email]",
        "li[data-identifier]",
        "div.BHzsHc",
    ]:
        try:
            els = await page.query_selector_all(sel)
            for el in els:
                if not el or not await el.is_visible():
                    continue
                # Check data attributes
                data_id = (await el.get_attribute("data-identifier") or "").lower()
                data_email = (await el.get_attribute("data-email") or "").lower()
                text = (await el.text_content() or "").lower()
                if data_id == lower or data_email == lower or lower in text:
                    await el.click()
                    await asyncio.sleep(1.0)
                    return True
        except Exception:
            continue

    # Fallback: find by email text
    try:
        loc = page.get_by_text(email, exact=False).first
        if await loc.count() > 0 and await loc.is_visible(timeout=1500):
            await loc.click(timeout=3000)
            await asyncio.sleep(1.0)
            return True
    except Exception:
        pass

    return False


async def _detect_blocking(page) -> str | None:
    """Detect Google blocking challenges (captcha, unusual traffic, etc.).

    Uses get_by_text / URL checks instead of page.evaluate() to avoid
    Camoufox hangs.
    """
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return None

    parsed = urlparse(current_url)
    path = (parsed.path or "").lower()

    # Check URL-based challenges first (fast, no DOM access)
    normal_challenge_paths = ["/challenge/pwd", "/challenge/selection"]
    if "/challenge/" in path:
        for np in normal_challenge_paths:
            if np in path:
                return None  # Normal auth step, not a block
        if "/challenge/recaptcha" in path:
            return "hard:recaptcha"
        return f"soft:google challenge ({path})"

    # Hard blocks — check page text via get_by_text
    hard_blocks = [
        "captcha",
        "try again later",
        "this browser or app may not be secure",
        "this browser may not be secure",
        "unusual traffic",
    ]
    for phrase in hard_blocks:
        try:
            loc = page.get_by_text(phrase, exact=False)
            if await loc.count() > 0 and await loc.first.is_visible(timeout=800):
                return f"hard:{phrase}"
        except Exception:
            continue

    # Soft challenges
    soft_challenges = [
        "verify it's you",
        "confirm it's you",
        "verify your identity",
        "recovery email",
        "recovery phone",
        "phone number",
    ]
    for phrase in soft_challenges:
        try:
            loc = page.get_by_text(phrase, exact=False)
            if await loc.count() > 0 and await loc.first.is_visible(timeout=800):
                return f"soft:{phrase}"
        except Exception:
            continue

    return None


async def _wait_for_challenge_resolved(page, timeout: int = 120) -> bool:
    """Wait for user to manually solve a challenge in the browser."""
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            current_url = page.url
        except Exception:
            current_url = ""

        if "accounts.google.com" not in current_url:
            return True

        at_email = await _is_email_step(page)
        at_password = await _is_password_step(page)
        if at_email or at_password:
            return True

        blocking = await _detect_blocking(page)
        if not blocking:
            return True

        remaining = int(timeout - (time.monotonic() - start))
        if remaining % 15 == 0 and remaining > 0:
            progress("challenge_wait", f"Waiting for manual solve... {remaining}s remaining")

        await asyncio.sleep(2.0)

    return False


async def _click_continue_button(target) -> None:
    """Click any generic continue/next button."""
    for text in ["Continue", "Next", "Accept", "I understand", "Agree", "OK", "Got it", "Login", "Sign in", "Lanjutkan", "Berikutnya"]:
        try:
            btn = target.get_by_text(text, exact=False).first
            if await btn.count() > 0 and await btn.is_visible():
                await btn.click(force=True)
                return
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Cline-specific helpers
# ---------------------------------------------------------------------------


async def _click_google_login_button(page) -> bool:
    """Click the Google login button on authkit.cline.bot.

    Uses query_selector / get_by_text instead of page.evaluate().
    """
    # Primary: anchor with data-method="google"
    try:
        el = await page.query_selector('a[data-method="google"]')
        if el and await el.is_visible():
            await el.click()
            debug("Clicked a[data-method='google']")
            return True
    except Exception as exc:
        debug(f"Google button primary selector error: {exc}")

    # Fallback: find by text
    for phrase in ["Sign in with Google", "Continue with Google", "Google"]:
        try:
            loc = page.get_by_text(phrase, exact=False).first
            if await loc.count() > 0 and await loc.is_visible(timeout=1500):
                await loc.click(timeout=3000)
                debug(f"Clicked Google button via text: {phrase}")
                return True
        except Exception:
            continue

    # Fallback: any button/link with google in href
    try:
        el = await page.query_selector('a[href*="google"]')
        if el and await el.is_visible():
            await el.click()
            debug("Clicked a[href*='google']")
            return True
    except Exception:
        pass

    return False


async def _handle_cline_registration(page) -> bool:
    """Handle Cline registration flow for new accounts.

    Steps: ToS checkbox -> Register -> Personal -> Continue
    Returns True if any action was taken.
    """
    acted = False

    # 1. ToS checkbox
    try:
        tos_checkbox = await page.query_selector('input[type="checkbox"]')
        if tos_checkbox and await tos_checkbox.is_visible():
            await tos_checkbox.click()
            debug("Clicked ToS checkbox")
            acted = True
            await asyncio.sleep(0.5)
    except Exception as exc:
        debug(f"ToS checkbox error: {exc}")

    # 2. Register button
    try:
        register_btn = await page.query_selector('button:has-text("Register")')
        if register_btn and await register_btn.is_visible():
            await register_btn.click()
            debug("Clicked Register button")
            acted = True
            await asyncio.sleep(1.0)
    except Exception as exc:
        debug(f"Register button error: {exc}")

    # 3. Personal option
    try:
        personal = await page.query_selector('span:has-text("Personal")')
        if personal and await personal.is_visible():
            await personal.click()
            debug("Clicked Personal")
            acted = True
            await asyncio.sleep(0.5)
    except Exception as exc:
        debug(f"Personal option error: {exc}")

    # 4. Continue button
    try:
        continue_btn = await page.query_selector('button:has-text("Continue")')
        if continue_btn and await continue_btn.is_visible():
            await continue_btn.click()
            debug("Clicked Continue button")
            acted = True
            await asyncio.sleep(1.0)
    except Exception as exc:
        debug(f"Continue button error: {exc}")

    return acted


def _decode_auth_code(code: str) -> dict:
    """Decode the base64url-encoded auth code from the callback.

    Returns a dict with accessToken, refreshToken, email, etc.
    """
    from urllib.parse import unquote
    # URL-decode first (code may contain %2B, %3D, etc.)
    code = unquote(code)
    # base64url -> base64 (pad to multiple of 4)
    padded = code + "=" * (4 - len(code) % 4)
    decoded = base64.urlsafe_b64decode(padded)
    # Try UTF-8, fallback to latin-1
    try:
        text = decoded.decode("utf-8", errors="ignore")
    except Exception:
        text = decoded.decode("latin-1", errors="ignore")
    # Find the JSON object boundaries (may have trailing garbage)
    start = text.find("{")
    if start == -1:
        raise ValueError("No JSON object found in decoded auth code")
    # Find matching closing brace
    depth = 0
    end = start
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    return json.loads(text[start:end])


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------


async def _fetch_user_info(access_token: str) -> dict:
    """Fetch user info from Cline API (/users/me)."""
    import aiohttp

    headers = {
        "Authorization": f"Bearer workos:{access_token}",
        "User-Agent": "Cline/3.79.0",
    }

    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                f"{CLINE_API_BASE}/users/me", headers=headers
            ) as resp:
                data = await resp.json()
                debug(f"User info response: {json.dumps(data)}")
                return data
    except Exception as exc:
        debug(f"Fetch user info error: {exc}")
        return {}


async def _fetch_balance(access_token: str, uid: str) -> dict:
    """Fetch user balance from Cline API (/users/{uid}/balance)."""
    import aiohttp

    headers = {
        "Authorization": f"Bearer workos:{access_token}",
        "User-Agent": "Cline/3.79.0",
        "Accept": "*/*",
    }

    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                f"{CLINE_API_BASE}/users/{uid}/balance", headers=headers
            ) as resp:
                data = await resp.json()
                debug(f"Balance response: {json.dumps(data)}")
                # Cline returns { data: { userId, balance }, success: true }
                if data.get("success") and data.get("data"):
                    balance = data["data"].get("balance", 0)
                    # balance is in credits (integer)
                    return {"balance": balance}
                return data
    except Exception as exc:
        debug(f"Fetch balance error: {exc}")
        return {}


async def _fetch_balance_via_page(page, uid: str) -> dict:
    """Fetch balance via browser page cookies (fallback if Bearer fails)."""
    try:
        result = await page.evaluate(
            """async ({ url }) => {
                try {
                    const resp = await fetch(url, {
                        credentials: 'include',
                        headers: { 'Accept': 'application/json' },
                    });
                    return await resp.json();
                } catch (err) {
                    return { error: String(err) };
                }
            }""",
            {"url": f"{CLINE_API_BASE}/users/{uid}/balance"},
        )
        if result and result.get("success") and result.get("data"):
            return {"balance": result["data"].get("balance", 0)}
        debug(f"Balance via page: {json.dumps(result)}")
    except Exception as exc:
        debug(f"Balance via page error: {exc}")
    return {}


# ---------------------------------------------------------------------------
# Main browser automation flow
# ---------------------------------------------------------------------------


async def run_login(email: str, password: str):
    """Main Cline login flow using Camoufox browser."""
    progress("init", f"Starting Cline login automation for {email}")

    try:
        from browserforge.fingerprints import Screen
        from camoufox.async_api import AsyncCamoufox
    except ImportError as exc:
        result_failure(
            f"Missing dependency: {exc}. Run: hexos auth setup-automation"
        )
        return

    headless = os.getenv("HEXOS_HEADLESS", "true").lower() == "true"

    camoufox_kwargs = {
        "headless": headless,
        "os": "windows",
        "block_webrtc": True,
        "disable_coop": True,
        "i_know_what_im_doing": True,
        "humanize": False,
        "screen": Screen(max_width=1920, max_height=1080),
    }

    # Proxy support
    proxy_url = (
        os.getenv("HEXOS_PROXY")
        or os.getenv("HEXOS_PROXY_URL")
        or os.getenv("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
    )
    if proxy_url:
        parsed = urlparse(proxy_url)
        proxy_cfg = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
        if parsed.username:
            proxy_cfg["username"] = parsed.username
        if parsed.password:
            proxy_cfg["password"] = parsed.password
        camoufox_kwargs["proxy"] = proxy_cfg
        progress("proxy", f"Using proxy: {parsed.hostname}:{parsed.port}")

    progress("browser_launch", "Launching Camoufox browser...")

    manager = AsyncCamoufox(**camoufox_kwargs)
    browser = None

    try:
        browser = await manager.__aenter__()
        page = await browser.new_page()
        page.set_default_timeout(15000)

        # ------------------------------------------------------------------
        # Set up route handler to intercept the callback redirect BEFORE
        # navigating.  The browser will try to hit http://127.0.0.1:48801/auth
        # which has nothing listening – we intercept and extract the code.
        # ------------------------------------------------------------------
        auth_code: str | None = None

        async def route_handler(route):
            nonlocal auth_code
            url = route.request.url
            if CALLBACK_HOST in url and "/auth" in url:
                parsed_cb = urlparse(url)
                params = parse_qs(parsed_cb.query)
                code = params.get("code", [None])[0]
                if code:
                    auth_code = code
                    debug(f"Intercepted auth code (len={len(code)})")
                await route.abort()
                return
            await route.continue_()

        await page.route("**/*", route_handler)

        # ------------------------------------------------------------------
        # Navigate to Cline auth URL
        # ------------------------------------------------------------------
        progress("navigate", "Navigating to Cline auth page...")
        try:
            await page.goto(CLINE_AUTH_URL, wait_until="domcontentloaded", timeout=20000)
        except Exception as exc:
            # The goto may fail if it immediately redirects to the callback
            # (unlikely for first visit, but handle gracefully)
            debug(f"Navigation exception (may be expected): {exc}")
            if auth_code:
                progress("auth_complete", "Auth code captured during navigation")

        await asyncio.sleep(2.0)

        # ------------------------------------------------------------------
        # Auth loop
        # ------------------------------------------------------------------
        progress("auth_loop", "Automating login flow...")
        page.set_default_timeout(5000)

        email_transition_deadline = 0.0
        password_transition_deadline = 0.0
        google_btn_clicked = False
        registration_handled = False
        last_debug_url = ""

        for iteration in range(AUTH_LOOP_MAX_ITERATIONS):
            # Check if we already captured the auth code
            if auth_code:
                progress("auth_complete", "Authentication callback intercepted!")
                break

            try:
                current_url = page.url
            except Exception:
                current_url = ""

            parsed_url = urlparse(current_url) if current_url else None
            current_host = parsed_url.netloc if parsed_url else ""
            on_google = "accounts.google.com" in current_host
            on_authkit = "authkit.cline.bot" in current_host
            on_cline = "cline.bot" in current_host and not on_authkit
            now = time.monotonic()

            on_api_cline = "api.cline.bot" in current_host

            # Debug: log URL changes
            if current_url != last_debug_url:
                debug(f"URL: {current_url}")
                last_debug_url = current_url

            # ----- On api.cline.bot: just a redirect hop, wait for it -----
            if on_api_cline:
                await asyncio.sleep(1.0)
                continue

            # ----- On authkit.cline.bot: radar challenge or Google login -----
            if on_authkit:
                current_path = parsed_url.path if parsed_url else ""

                # WorkOS Radar challenge (authkit.cline.bot/radar-challenge/...)
                # Cline requires phone/email verification — cannot be automated.
                # Skip this account so the batch can continue with the next one.
                if "/radar-challenge" in current_path:
                    result_failure(
                        "Skipped — Cline identity verification required (phone/email code)"
                    )
                    return

                # Normal authkit page: click Google login button
                clicked = await _click_google_login_button(page)
                if clicked:
                    google_btn_clicked = True
                    await asyncio.sleep(2.0)
                    continue

            # ----- On Google: handle email / password -----
            if on_google:
                at_password = await _is_password_step(page)
                at_email = await _is_email_step(page)

                if at_email and not at_password:
                    if now < email_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    progress("google_email", "Filling Google email...")
                    filled = await _fill_email(page, email)
                    if filled:
                        email_transition_deadline = time.monotonic() + 6.0
                        progress("google_email_done", "Email submitted")
                        await asyncio.sleep(1.0)
                        continue
                    else:
                        progress("google_email_fail", "Failed to fill email, retrying...")

                if at_password:
                    if now < password_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    progress("google_password", "Filling Google password...")
                    filled = await _fill_password(page, password)
                    if filled:
                        password_transition_deadline = time.monotonic() + 8.0
                        progress("google_password_done", "Password submitted")
                        await asyncio.sleep(1.0)
                        continue

                # Account picker
                if not at_email and not at_password and await _is_account_picker(page):
                    debug("Account picker detected")
                    picked = await _click_account_in_picker(page, email)
                    if picked:
                        await asyncio.sleep(2.0)
                        continue
                    await _click_continue_button(page)
                    await asyncio.sleep(1.5)
                    continue

                if at_email or at_password:
                    await asyncio.sleep(0.6)
                    continue

            # ----- Google G+ ToS -----
            if on_google and await _handle_google_gaplustos(page):
                await asyncio.sleep(0.8)
                continue

            # ----- Google consent -----
            if on_google and await _handle_google_consent(page):
                await asyncio.sleep(0.8)
                continue

            # ----- Authorize button (authkit.cline.bot) -----
            if "authkit.cline.bot" in current_url or "cline.bot" in current_host:
                authorized = False
                # Try by role first
                for label in ["Authorize", "Allow", "Confirm"]:
                    try:
                        btn = page.get_by_role("button", name=label).first
                        if await btn.count() > 0 and await btn.is_visible(timeout=1500):
                            progress("authorize", f"Clicking {label} button...")
                            await btn.click(timeout=3000)
                            authorized = True
                            break
                    except Exception:
                        continue
                # Fallback: query_selector
                if not authorized:
                    for sel in ['button:has-text("Authorize")', 'button[type="submit"]']:
                        try:
                            el = await page.query_selector(sel)
                            if el and await el.is_visible():
                                progress("authorize", "Clicking Authorize button...")
                                await el.click()
                                authorized = True
                                break
                        except Exception:
                            continue
                if authorized:
                    await asyncio.sleep(2.0)
                    continue

            # ----- Cline registration (new accounts) -----
            if on_cline and not registration_handled:
                progress("registration", "Checking for Cline registration...")
                acted = await _handle_cline_registration(page)
                if acted:
                    registration_handled = True
                    progress("registration_done", "Registration steps completed")
                    await asyncio.sleep(2.0)
                    continue

            # ----- Detect Google blocking -----
            blocking = await _detect_blocking(page) if on_google else None
            if blocking:
                is_headless = os.getenv("HEXOS_HEADLESS", "true").lower() == "true"

                if blocking.startswith("hard:"):
                    block_reason = blocking[5:]
                    if not is_headless:
                        progress(
                            "challenge",
                            f"Challenge detected: {block_reason} — solve it in the browser window (waiting 120s)...",
                        )
                        solved = await _wait_for_challenge_resolved(page, timeout=120)
                        if solved:
                            progress("challenge_solved", "Challenge resolved! Continuing...")
                            continue
                    result_failure(
                        f"Google blocked: {block_reason}. Try with --no-headless to solve manually"
                    )
                    return

                elif blocking.startswith("soft:"):
                    challenge_type = blocking[5:]
                    if not is_headless:
                        progress(
                            "challenge",
                            f"Verification required: {challenge_type} — complete it in the browser window (waiting 120s)...",
                        )
                        solved = await _wait_for_challenge_resolved(page, timeout=120)
                        if solved:
                            progress("challenge_solved", "Verification completed! Continuing...")
                            continue
                        result_failure(f"Verification timeout: {challenge_type}")
                        return
                    else:
                        result_failure(
                            f"Verification required: {challenge_type}. Try with --no-headless to solve manually"
                        )
                        return

            # ----- Fallback: click any continue-like button -----
            await _click_continue_button(page)
            await asyncio.sleep(1.0)
        else:
            # Loop exhausted without capturing auth code
            result_failure("Auth loop timeout: did not receive callback in time")
            return

        # ------------------------------------------------------------------
        # Decode the auth code
        # ------------------------------------------------------------------
        if not auth_code:
            result_failure("No auth code captured")
            return

        progress("decode_token", "Decoding authentication token...")
        try:
            token_data = _decode_auth_code(auth_code)
        except Exception as exc:
            result_failure(f"Failed to decode auth code: {exc}")
            return

        access_token = token_data.get("accessToken", "")
        refresh_token = token_data.get("refreshToken", "")
        token_email = token_data.get("email", email)
        expires_at = token_data.get("expiresAt", "")

        if not access_token:
            result_failure("Decoded token has no accessToken")
            return

        debug(f"Token decoded: email={token_email}, expiresAt={expires_at}")

        # ------------------------------------------------------------------
        # Fetch user info
        # ------------------------------------------------------------------
        progress("fetch_user", "Fetching user info...")
        user_data = await _fetch_user_info(access_token)
        # API returns { data: { id: "usr-...", email: "..." }, success: true }
        if user_data.get("data"):
            uid = user_data["data"].get("id", "")
        else:
            uid = user_data.get("id", "")

        # ------------------------------------------------------------------
        # Fetch balance
        # ------------------------------------------------------------------
        credit = None
        if uid:
            progress("fetch_balance", "Fetching account balance...")
            # Try Bearer token first
            balance_data = await _fetch_balance(access_token, uid)
            balance = balance_data.get("balance", 0)
            
            # Fallback: fetch via browser page cookies
            if balance == 0 and page:
                debug("Bearer balance returned 0, trying via browser cookies...")
                balance_data_page = await _fetch_balance_via_page(page, uid)
                balance = balance_data_page.get("balance", balance)
            
            credit = {
                "totalCredits": balance,
                "remainingCredits": balance,
                "usedCredits": 0,
                "packageName": "Cline",
                "expiresAt": expires_at,
            }
            progress(
                "credit_info",
                f"Balance: {balance} credits",
            )
        else:
            debug("No UID available, skipping balance fetch")
            credit = {
                "totalCredits": 0,
                "remainingCredits": 0,
                "usedCredits": 0,
                "packageName": "Cline",
                "expiresAt": expires_at,
            }

        # ------------------------------------------------------------------
        # Return result
        # ------------------------------------------------------------------
        result_success(
            access_token=access_token,
            refresh_token=refresh_token,
            uid=uid,
            email=token_email,
            credit=credit,
        )

    except Exception as exc:
        result_failure(f"Browser automation error: {exc}")
    finally:
        if browser:
            try:
                await manager.__aexit__(None, None, None)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main():
    parser = argparse.ArgumentParser(description="Hexos Cline browser login")
    parser.add_argument("--email", required=True, help="Google email")
    parser.add_argument("--password", required=True, help="Google password")
    args = parser.parse_args()

    await run_login(args.email, args.password)


if __name__ == "__main__":
    asyncio.run(main())
