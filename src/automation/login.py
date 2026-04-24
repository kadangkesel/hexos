#!/usr/bin/env python3
"""
Hexos Browser Automation Login
Automates CodeBuddy OAuth login via Google using Camoufox (anti-detect browser).

Usage:
    python login.py --email user@gmail.com --password secret --state xxx --auth-url https://...

Output (JSON lines on stdout):
    {"type": "progress", "step": "...", "message": "..."}
    {"type": "result", "success": true, "accessToken": "...", "refreshToken": "...", "uid": "..."}
    {"type": "error", "error": "..."}
"""

import argparse
import asyncio
import json
import os
import re
import sys
import time
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CODEBUDDY_BASE_URL = os.getenv("HEXOS_CODEBUDDY_BASE_URL", "https://www.codebuddy.ai")
CODEBUDDY_PLATFORM = "CLI"
CODEBUDDY_REDIRECT_SCHEME = "codebuddy://"
POLL_INTERVAL = 2.0
POLL_TIMEOUT = 90.0
AUTH_LOOP_MAX_ITERATIONS = 200
DEBUG = os.getenv("HEXOS_DEBUG", "false").lower() == "true"

CLI_HEADERS = {
    "Content-Type": "application/json",
    "X-Domain": "www.codebuddy.ai",
    "User-Agent": "codebuddy/2.91.0",
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def emit(data: dict):
    """Emit a JSON line to stdout for the parent Bun process to consume."""
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


def result_success(access_token: str, refresh_token: str, uid: str, credit: dict | None = None, web_cookie: str | None = None):
    data = {
        "type": "result",
        "success": True,
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "uid": uid,
    }
    if credit:
        data["credit"] = credit
    if web_cookie:
        data["webCookie"] = web_cookie
    emit(data)


def result_failure(message: str):
    emit({"type": "result", "success": False, "error": message})


# ---------------------------------------------------------------------------
# Google OAuth form helpers (adapted from enowxai codebuddy.py)
# ---------------------------------------------------------------------------


async def _fill_google_email_step(page, email: str) -> bool:
    """Fill the Google email field and submit."""
    selectors = [
        "#identifierId",
        'input[type="email"]',
        'input[name="identifier"]',
        'input[autocomplete="username"]',
        'input[autocomplete="email"]',
    ]

    # Try each selector
    found_selector = None
    for selector in selectors:
        try:
            await page.wait_for_selector(selector, state="visible", timeout=3000)
            found_selector = selector
            break
        except Exception:
            continue

    if not found_selector:
        # Last resort: find any visible text/email input on the page
        debug(f"Standard selectors failed. Trying fallback input detection...")
        try:
            found_fallback = await page.evaluate("""() => {
                const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
                for (const el of inputs) {
                    if (el.offsetParent !== null && (el.type === 'text' || el.type === 'email' || el.type === '')) {
                        return el.id || el.name || el.type || 'unknown';
                    }
                }
                return null;
            }""")
            if found_fallback:
                debug(f"Fallback found input: {found_fallback}")
                # Try clicking and typing directly
                await page.evaluate("""(email) => {
                    const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
                    for (const el of inputs) {
                        if (el.offsetParent !== null && (el.type === 'text' || el.type === 'email' || el.type === '')) {
                            el.focus();
                            el.value = email;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            return true;
                        }
                    }
                    return false;
                }""", email)
                await asyncio.sleep(0.5)
                # Try clicking Next
                clicked = await _click_google_next(page)
                if not clicked:
                    await page.keyboard.press("Enter")
                await asyncio.sleep(2.0)
                return True
        except Exception as exc:
            debug(f"Fallback input error: {exc}")

        debug(f"No email input found at all on page")
        return False

    selector = found_selector
    debug(f"Found email field with selector: {selector}")

    try:
        locator = page.locator(selector).first
        if await locator.count() == 0:
            debug(f"Locator count is 0 for {selector}")
            return False
        if not await locator.is_visible():
            debug(f"Locator not visible for {selector}")
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

        # Type character by character (same as enowxai reference)
        try:
            await locator.press_sequentially(email, delay=60)
        except Exception as exc:
            debug(f"press_sequentially failed: {exc}")
            return False

        await asyncio.sleep(0.5)

        # Verify typed value
        val = await locator.input_value()
        if email.lower() != str(val).lower().strip():
            debug(f"Email mismatch: typed={val!r} expected={email!r}")
            return False

        await asyncio.sleep(0.3)

        # Click Next or press Enter
        clicked = await _click_google_next(page)
        if not clicked:
            await locator.press("Enter")

        # Wait for transition
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


async def _fill_google_password_step(page, password: str) -> bool:
    """Fill the Google password field and submit."""
    selectors = ['input[name="Passwd"]', 'input[type="password"]']
    for selector in selectors:
        try:
            try:
                await page.wait_for_selector(selector, state="visible", timeout=5000)
            except Exception:
                continue

            locator = page.locator(selector).first
            if await locator.count() == 0:
                continue
            if not await locator.is_visible():
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(password, delay=70)
            except Exception as exc:
                debug(f"Password press_sequentially failed: {exc}")
                continue

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

            clicked = await _click_google_next(page)
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


async def _click_google_next(page) -> bool:
    """Click the Google Next button."""
    try:
        return bool(
            await page.evaluate(
                """() => {
                    const btn = document.querySelector(
                        '#identifierNext button, #passwordNext button, #identifierNext, #passwordNext'
                    );
                    if (btn && btn.offsetParent !== null) {
                        btn.click();
                        return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _wait_for_transition(page, check_fn: str, timeout: int = 10000):
    """Wait for a page transition using a JS check function."""
    try:
        await page.wait_for_function(check_fn, timeout=timeout)
    except Exception:
        pass


async def _handle_page_expired(page, progress=None) -> bool:
    """Detect 'Page has expired' and click the restart link.

    Returns True if the expired page was detected and handled.
    The page text is:
        "Page has expired"
        "To restart the login process Click here."
        "To continue the login process Click here."
    We click the *restart* link (first <a> tag) to get a fresh session.
    """
    try:
        expired_loc = page.get_by_text("Page has expired", exact=False)
        if await expired_loc.count() == 0:
            return False
        if not await expired_loc.first.is_visible(timeout=2000):
            return False
    except Exception:
        return False

    if progress:
        progress("navigate", "Page expired detected, clicking restart link...")

    # The page has two "Click here" links. The first one is "restart", the
    # second is "continue".  Target the restart link specifically by looking
    # for the <a> inside the paragraph that contains "restart".
    clicked = False

    # Try 1: click the <a> tag inside the "restart" sentence
    try:
        restart_p = page.get_by_text("restart the login process", exact=False).first
        if await restart_p.is_visible(timeout=1500):
            # The <a> is a child — use locator chaining
            link = restart_p.locator("a").first
            if await link.count() > 0 and await link.is_visible(timeout=1000):
                await link.click(timeout=3000)
                clicked = True
    except Exception:
        pass

    # Try 2: query_selector for the first <a> on the page (restart link)
    if not clicked:
        try:
            first_link = await page.query_selector("a[href]")
            if first_link and await first_link.is_visible():
                await first_link.click(timeout=3000)
                clicked = True
        except Exception:
            pass

    # Try 3: click any link with "Click here" text (first match = restart)
    if not clicked:
        try:
            link = page.get_by_role("link", name="Click here").first
            if await link.is_visible(timeout=1500):
                await link.click(timeout=3000)
                clicked = True
        except Exception:
            pass

    if clicked:
        # Wait for navigation to complete
        await asyncio.sleep(2.5)
        return True

    # If none of the links worked, do NOT reload (reload causes expired loop).
    # Just return True so the caller knows we saw the expired page and can
    # let the next iteration try again.
    return True


async def _handle_codebuddy_landing(page) -> bool:
    """Handle the CodeBuddy login landing page: click ToS checkbox + Google button.

    Uses query_selector / get_by_text instead of page.evaluate() to avoid
    Camoufox hangs.
    """
    # Determine target: iframe or main page
    target = page
    for selector in [
        'iframe[title="login-iframe"]',
        'iframe[src*="/auth/realms/copilot/protocol/openid-connect/auth"]',
    ]:
        try:
            iframe_el = await page.query_selector(selector)
            if iframe_el:
                frame = await iframe_el.content_frame()
                if frame:
                    target = frame
                    break
        except Exception:
            continue

    clicked_checkbox = False
    clicked_google = False

    # Click ToS checkbox (div.checkmark)
    try:
        chk = await target.query_selector("div.checkmark")
        if chk and await chk.is_visible():
            await chk.click(timeout=3000)
            clicked_checkbox = True
            await asyncio.sleep(0.3)
    except Exception:
        pass

    # Also try input[type=checkbox] or label with checkbox
    if not clicked_checkbox:
        for sel in ["input[type='checkbox']", "label.checkbox", "span.checkmark"]:
            try:
                el = await target.query_selector(sel)
                if el and await el.is_visible():
                    await el.click(timeout=3000)
                    clicked_checkbox = True
                    await asyncio.sleep(0.3)
                    break
            except Exception:
                continue

    # Click Google login button by id
    try:
        google_btn = await target.query_selector("#social-google")
        if google_btn and await google_btn.is_visible():
            await google_btn.click(timeout=3000)
            clicked_google = True
    except Exception:
        pass

    # Click Google login link by href
    if not clicked_google:
        try:
            google_link = await target.query_selector('a[href*="/broker/google/login"]')
            if google_link and await google_link.is_visible():
                await google_link.click(timeout=3000)
                clicked_google = True
        except Exception:
            pass

    # Fallback: find button/link with Google-related text
    if not clicked_google:
        for phrase in ["Sign in with Google", "Login with Google", "Continue with Google", "Google"]:
            try:
                loc = target.get_by_text(phrase, exact=False).first
                if await loc.is_visible(timeout=1500):
                    await loc.click(timeout=3000)
                    clicked_google = True
                    break
            except Exception:
                continue

    return clicked_checkbox or clicked_google


async def _handle_google_consent(page) -> bool:
    """Handle Google consent/continue page."""
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return False

    # Try multiple selectors for consent/continue/allow buttons
    for text in ["Continue", "Allow", "Lanjutkan", "Izinkan", "continue", "allow"]:
        try:
            btn = page.get_by_text(text, exact=False).first
            if await btn.count() > 0 and await btn.is_visible():
                await btn.click(force=True)
                debug(f"Clicked consent button: {text}")
                return True
        except Exception:
            pass

    # Fallback: try specific selectors
    for selector in ['button[type="submit"]', '#submit_approve_access', 'button:has-text("Continue")', 'button:has-text("Lanjutkan")']:
        try:
            el = await page.query_selector(selector)
            if el and await el.is_visible():
                await el.click(force=True)
                debug(f"Clicked consent via selector: {selector}")
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
                if await locator.count() == 0:
                    continue
                if not await locator.is_visible():
                    continue
                await locator.click(force=True)
                return True
            except Exception:
                continue

        # Fallback: try text-based buttons
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


async def _handle_codebuddy_region(page) -> bool:
    """Handle CodeBuddy region selection page (select Singapore)."""
    try:
        current_url = page.url
    except Exception:
        current_url = ""

    parsed = urlparse(current_url) if current_url else None
    host = parsed.netloc if parsed else ""
    path = parsed.path if parsed else ""

    if host != urlparse(CODEBUDDY_BASE_URL).netloc or not path.startswith(
        "/register/user/complete"
    ):
        return False

    debug("Region selection page detected")

    try:
        try:
            await page.wait_for_selector(
                'div.t-input input[placeholder="Registration location"]',
                state="visible",
                timeout=3000,
            )
        except Exception:
            return False

        # Check current region value
        region_value = str(
            await page.evaluate(
                """() => {
                    const box = document.querySelector('div.t-input input[placeholder="Registration location"]');
                    return box && box.offsetParent !== null ? (box.value || '') : '';
                }"""
            )
        ).strip()

        if region_value.lower() != "singapore":
            # Open dropdown
            await page.evaluate(
                """() => {
                    const box = document.querySelector('div.t-input input[placeholder="Registration location"]');
                    if (box) box.click();
                }"""
            )
            await asyncio.sleep(0.3)

            # Search for Singapore
            try:
                overlay_search = page.locator(
                    '.dropdown-overlay input[placeholder="Search countries"], .dropdown-search input[placeholder="Search countries"]'
                ).first
                if await overlay_search.count() > 0 and await overlay_search.is_visible():
                    await overlay_search.click(force=True)
                    await overlay_search.fill("Singapore")
                    await asyncio.sleep(0.25)
            except Exception:
                pass

            # Click Singapore option
            selected = False
            for locator in [
                page.locator(".dropdown-overlay").get_by_text("Singapore", exact=True).first,
                page.get_by_text("Singapore", exact=True).first,
            ]:
                try:
                    if await locator.count() > 0 and await locator.is_visible():
                        await locator.click(force=True)
                        selected = True
                        break
                except Exception:
                    continue

            if not selected:
                await page.evaluate(
                    """() => {
                        const selectors = ['.dropdown-overlay [role="option"]', '.dropdown-overlay li', '.dropdown-overlay div'];
                        for (const sel of selectors) {
                            for (const el of document.querySelectorAll(sel)) {
                                const txt = (el.textContent || '').toLowerCase().trim();
                                if (el.offsetParent !== null && (txt === 'singapore' || txt.includes('singapore'))) {
                                    el.click();
                                    return true;
                                }
                            }
                        }
                        return false;
                    }"""
                )
            await asyncio.sleep(0.3)

        # Click Submit
        submitted = False
        for locator in [
            page.locator('button:has-text("Submit")').first,
            page.get_by_text("Submit", exact=True).first,
        ]:
            try:
                if await locator.count() > 0 and await locator.is_visible():
                    await locator.click(force=True)
                    submitted = True
                    break
            except Exception:
                continue

        if not submitted:
            await page.evaluate(
                """() => {
                    for (const el of document.querySelectorAll('button, [role="button"]')) {
                        const txt = (el.textContent || '').trim().toLowerCase();
                        if (el.offsetParent !== null && txt.includes('submit')) {
                            el.click();
                            return true;
                        }
                    }
                    return false;
                }"""
            )

        debug(f"Region submit clicked={submitted}")
        if submitted:
            try:
                await page.wait_for_function(
                    """() => {
                        const path = window.location.pathname || '';
                        return path === '/started' || !path.startsWith('/register/user/complete');
                    }""",
                    timeout=8000,
                )
            except Exception:
                pass
        return submitted
    except Exception as exc:
        debug(f"Region handler error: {exc}")
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


async def _is_email_step(page) -> bool:
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
    try:
        for sel in ['input[name="Passwd"]', 'input[type="password"]']:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                return True
        return False
    except Exception as exc:
        debug(f"_is_password_step error: {exc}")
        return False


async def _detect_blocking(page) -> str | None:
    """Detect Google blocking challenges (captcha, unusual traffic, etc.).
    
    Returns None if no blocking detected, or a string describing the block.
    Normal auth paths like /challenge/pwd (password) are NOT considered blocks.
    """
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return None

    try:
        marker = str(
            await page.evaluate(
                """() => {
                    const text = (document.body?.innerText || '').toLowerCase();
                    const path = (window.location.pathname || '').toLowerCase();
                    
                    // Hard blocks — these are definite bot detection
                    const hardBlocks = [
                        'captcha',
                        'try again later',
                        'this browser or app may not be secure',
                        'this browser may not be secure',
                        'unusual traffic',
                    ];
                    for (const m of hardBlocks) {
                        if (text.includes(m)) return 'hard:' + m;
                    }
                    
                    // Soft challenges — may be solvable by user
                    const softChallenges = [
                        "verify it's you",
                        "confirm it's you",
                        'verify your identity',
                        'recovery email',
                        'recovery phone',
                        'phone number',
                    ];
                    for (const m of softChallenges) {
                        if (text.includes(m)) return 'soft:' + m;
                    }
                    
                    // /challenge/ paths that are NOT blocks:
                    //   /challenge/pwd  = normal password step
                    //   /challenge/recaptcha = captcha (hard block)
                    //   /challenge/selection = account selection
                    //   /challenge/ipp = phone verification (soft)
                    const normalChallengePaths = ['/challenge/pwd', '/challenge/selection'];
                    if (path.includes('/challenge/')) {
                        for (const np of normalChallengePaths) {
                            if (path.includes(np)) return '';
                        }
                        if (path.includes('/challenge/recaptcha')) return 'hard:recaptcha';
                        return 'soft:google challenge (' + path + ')';
                    }
                    
                    return '';
                }"""
            )
        ).strip()
        return marker or None
    except Exception:
        return None


async def _wait_for_challenge_resolved(page, timeout: int = 120) -> bool:
    """Wait for user to manually solve a challenge in the browser.
    Returns True if the page navigated away from the challenge."""
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            current_url = page.url
        except Exception:
            current_url = ""
        
        # If we left Google accounts entirely, challenge is resolved
        if "accounts.google.com" not in current_url:
            return True
        
        # If we're back on a normal step (email/password), resolved
        at_email = await _is_email_step(page)
        at_password = await _is_password_step(page)
        if at_email or at_password:
            return True
        
        # Check if blocking markers are gone
        blocking = await _detect_blocking(page)
        if not blocking:
            return True
        
        remaining = int(timeout - (time.monotonic() - start))
        if remaining % 15 == 0 and remaining > 0:
            progress("challenge_wait", f"Waiting for manual solve... {remaining}s remaining")
        
        await asyncio.sleep(2.0)
    
    return False


async def _is_account_picker(page) -> bool:
    """Detect Google account picker page."""
    try:
        return bool(
            await page.evaluate(
                """() => {
                    const hasPassword = Array.from(
                        document.querySelectorAll('input[type="password"], input[name="Passwd"]')
                    ).some(el => el.offsetParent !== null);
                    if (hasPassword) return false;
                    const hasEmail = Array.from(
                        document.querySelectorAll('#identifierId, input[name="identifier"], input[type="email"]')
                    ).some(el => el.offsetParent !== null);
                    if (hasEmail) return false;
                    const selectors = ['div[data-identifier]', 'div[data-email]', 'li[data-identifier]', 'div.BHzsHc'];
                    for (const sel of selectors) {
                        for (const el of document.querySelectorAll(sel)) {
                            if ((el.textContent || '').includes('@') && el.offsetParent !== null) return true;
                        }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _click_account_in_picker(page, email: str) -> bool:
    """Click the matching account in Google account picker."""
    try:
        clicked = bool(
            await page.evaluate(
                """(email) => {
                    const lower = email.toLowerCase();
                    const selectors = ['div[data-identifier]', 'div[data-email]', 'li[data-identifier]', 'div.BHzsHc'];
                    for (const sel of selectors) {
                        for (const el of document.querySelectorAll(sel)) {
                            const id = (el.getAttribute('data-identifier') || el.getAttribute('data-email') || '').toLowerCase();
                            const txt = (el.textContent || '').toLowerCase();
                            if ((id === lower || txt.includes(lower)) && el.offsetParent !== null) {
                                el.click();
                                return true;
                            }
                        }
                    }
                    return false;
                }""",
                email,
            )
        )
        if clicked:
            await asyncio.sleep(1.0)
        return clicked
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Token polling (reuse existing CodeBuddy device-code flow)
# ---------------------------------------------------------------------------


async def poll_token(state: str) -> dict:
    """Poll CodeBuddy for token after browser auth completes."""
    import aiohttp

    url = f"{CODEBUDDY_BASE_URL}/v2/plugin/auth/token"
    headers = {**CLI_HEADERS}
    del headers["Content-Type"]  # GET request

    timeout = aiohttp.ClientTimeout(total=15)
    start = time.time()

    while time.time() - start < POLL_TIMEOUT:
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(
                    f"{url}?state={state}&platform={CODEBUDDY_PLATFORM}",
                    headers=headers,
                ) as resp:
                    data = await resp.json()
                    if data.get("code") == 0 and data.get("data", {}).get("accessToken"):
                        token_data = data["data"]
                        access = token_data["accessToken"]
                        refresh = token_data.get("refreshToken", "")
                        debug(f"Token poll success: accessToken={access[:20]}... refreshToken={'present (' + refresh[:20] + '...)' if refresh else 'EMPTY'}")
                        debug(f"Token poll response keys: {list(token_data.keys())}")
                        if not refresh:
                            # Log full response to help debug missing refresh token
                            progress("warn_no_refresh", f"WARNING: No refreshToken in poll response. Keys: {list(token_data.keys())}")
                        return {
                            "accessToken": access,
                            "refreshToken": refresh,
                        }
                    # 11217 = still waiting for auth
                    if data.get("code") != 11217:
                        return {"error": f"Auth error: {json.dumps(data)}"}
        except Exception as exc:
            debug(f"Poll error: {exc}")

        await asyncio.sleep(POLL_INTERVAL)

    return {"error": "Token poll timeout"}


async def extract_web_cookies(context) -> str:
    """Extract cookies from browser context as a Cookie header string.
    
    These cookies can be replayed later to call the billing API
    without needing a full browser session.
    """
    try:
        cookies = await context.cookies()
        # Filter to Service domain cookies only
        cb_cookies = [c for c in cookies if "Service" in (c.get("domain", "") or "")]
        if not cb_cookies:
            cb_cookies = cookies  # fallback: use all cookies
        parts = []
        for c in cb_cookies:
            name = c.get("name", "")
            value = c.get("value", "")
            if name and value:
                parts.append(f"{name}={value}")
        return "; ".join(parts)
    except Exception as exc:
        debug(f"Cookie extraction error: {exc}")
        return ""


async def fetch_credit_via_page(page) -> dict | None:
    """Fetch credit/quota info via browser page (uses cookie session).
    
    The billing API requires cookie auth, not Bearer token.
    Since the browser already has the session cookies after login,
    we execute fetch() from within the page context.
    """
    if page is None:
        return None

    from datetime import datetime, timedelta
    now = datetime.utcnow()
    begin = now.strftime("%Y-%m-%d %H:%M:%S")
    end = (now + timedelta(days=365 * 100)).strftime("%Y-%m-%d %H:%M:%S")

    try:
        # First navigate to CodeBuddy to ensure cookies are set for the right domain
        try:
            current_url = page.url
            if "codebuddy.ai" not in current_url:
                await page.goto(f"{CODEBUDDY_BASE_URL}/profile", wait_until="domcontentloaded", timeout=10000)
                await asyncio.sleep(1.0)
        except Exception:
            pass

        result = await page.evaluate(
            """async ({ url, body }) => {
                try {
                    const resp = await fetch(url, {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                        },
                        body: JSON.stringify(body),
                    });
                    const text = await resp.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch {}
                    return { status: resp.status, json };
                } catch (err) {
                    return { status: 0, json: null, error: String(err) };
                }
            }""",
            {
                "url": f"{CODEBUDDY_BASE_URL}/billing/meter/get-user-resource",
                "body": {
                    "PageNumber": 1,
                    "PageSize": 300,
                    "ProductCode": "p_tcaca",
                    "Status": [0, 3],
                    "PackageEndTimeRangeBegin": begin,
                    "PackageEndTimeRangeEnd": end,
                },
            },
        )

        status = int(result.get("status") or 0)
        payload = result.get("json")

        if status != 200 or not isinstance(payload, dict):
            debug(f"Credit fetch via page: status={status}")
            return None

        if payload.get("code") != 0:
            debug(f"Credit fetch via page: code={payload.get('code')}")
            return None

        response_data = (payload.get("data", {}).get("Response", {}).get("Data", {}))
        total_dosage = float(response_data.get("TotalDosage", 0))
        accounts = response_data.get("Accounts", [])

        total_remain = 0.0
        total_used = 0.0
        total_size = 0.0
        package_name = ""
        expires_at = ""

        for acct in accounts:
            total_remain += float(acct.get("CapacityRemain", 0))
            total_used += float(acct.get("CapacityUsed", 0))
            total_size += float(acct.get("CapacitySize", 0))
            if not package_name:
                package_name = acct.get("PackageName", "")
            if not expires_at:
                expires_at = acct.get("CycleEndTime", "")

        return {
            "totalCredits": total_dosage if total_dosage > total_size else total_size,
            "remainingCredits": total_dosage if total_dosage > total_remain else total_remain,
            "usedCredits": total_used,
            "packageName": package_name,
            "expiresAt": expires_at,
        }
    except Exception as exc:
        debug(f"Credit fetch via page error: {exc}")
        return None


async def fetch_uid(access_token: str) -> str:
    """Fetch user ID from CodeBuddy accounts endpoint."""
    import aiohttp

    url = f"{CODEBUDDY_BASE_URL}/v2/plugin/accounts"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "X-Domain": "www.codebuddy.ai",
        "User-Agent": "codebuddy/2.91.0",
    }

    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as resp:
                data = await resp.json()
                return data.get("data", {}).get("uid", "") or data.get("data", {}).get(
                    "userId", ""
                )
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Main browser automation flow
# ---------------------------------------------------------------------------


async def run_login(email: str, password: str, state: str, auth_url: str):
    """Main login flow using Camoufox browser."""
    progress("init", f"Starting browser automation for {email}")

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
    proxy_url = os.getenv("HEXOS_PROXY") or os.getenv("HEXOS_PROXY_URL") or os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY")
    if proxy_url:
        parsed = urlparse(proxy_url)
        proxy_cfg = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
        if parsed.username:
            proxy_cfg["username"] = parsed.username
        if parsed.password:
            proxy_cfg["password"] = parsed.password
        camoufox_kwargs["proxy"] = proxy_cfg
        camoufox_kwargs["geoip"] = True
        progress("proxy", f"Using proxy: {parsed.hostname}:{parsed.port}")

    progress("browser_launch", "Launching Camoufox browser...")

    manager = AsyncCamoufox(**camoufox_kwargs)
    browser = None
    page = None

    try:
        browser = await manager.__aenter__()
        context = browser.contexts[0] if browser.contexts else None

        # Clear any leftover cookies/storage from previous (killed) sessions
        if context:
            try:
                await context.clear_cookies()
            except Exception:
                pass

        page = await browser.new_page()
        page.set_default_timeout(15000)

        progress("navigate", f"Navigating to CodeBuddy auth page...")
        await page.goto(auth_url, wait_until="domcontentloaded", timeout=20000)

        # Detect "page has expired" and click the restart link
        await _handle_page_expired(page, progress)

        # Step 1: Handle CodeBuddy landing (checkbox + Google button)
        progress("landing", "Handling CodeBuddy login page...")
        for _ in range(10):
            try:
                current_url = page.url
            except Exception:
                current_url = ""
            if "accounts.google.com" in current_url:
                break
            landing_clicked = await _handle_codebuddy_landing(page)
            if landing_clicked:
                await asyncio.sleep(1.0)
                break
            await asyncio.sleep(0.5)

        # Wait for Google page to fully load
        progress("auth_loop", "Waiting for login page...")
        await asyncio.sleep(3.0)
        
        progress("auth_loop", "Automating Google login...")
        
        # Set a short default timeout for all page operations in the auth loop
        page.set_default_timeout(5000)
        
        email_transition_deadline = 0.0
        password_transition_deadline = 0.0
        region_transition_deadline = 0.0
        codebuddy_netloc = urlparse(CODEBUDDY_BASE_URL).netloc

        # Start polling for token in background immediately.
        # The token becomes available once the browser completes the OAuth flow,
        # even if the browser hasn't navigated to /started yet.
        poll_task = asyncio.create_task(poll_token(state))

        auth_success = False
        last_debug_url = ""
        expired_retries = 0
        MAX_EXPIRED_RETRIES = 5

        for iteration in range(AUTH_LOOP_MAX_ITERATIONS):
            
            # Check if token poll already succeeded in background
            if poll_task.done():
                token_check = poll_task.result()
                if "error" not in token_check:
                    progress("auth_complete", "Authentication successful (token received)!")
                    auth_success = True
                    break

            try:
                current_url = page.url
            except Exception:
                current_url = ""

            parsed_url = urlparse(current_url) if current_url else None
            current_host = parsed_url.netloc if parsed_url else ""
            current_path = parsed_url.path if parsed_url else ""
            on_google = "accounts.google.com" in current_host
            on_codebuddy = current_host == codebuddy_netloc
            on_codebuddy_region = (
                on_codebuddy
                and current_path.startswith("/register/user/complete")
            )
            now = time.monotonic()

            # Debug: log URL changes
            if current_url != last_debug_url:
                debug(f"URL changed: {current_url}")
                last_debug_url = current_url

            # Check if we reached the /started callback
            if on_codebuddy and current_path == "/started":
                q = parse_qs(parsed_url.query) if parsed_url else {}
                if q.get("state", [""])[0] == state:
                    progress("auth_complete", "Authentication successful!")
                    auth_success = True
                    break

            # Check redirect scheme
            if current_url.startswith(CODEBUDDY_REDIRECT_SCHEME):
                progress("auth_complete", "Authentication successful (redirect)!")
                auth_success = True
                break

            # Check if we landed on any CodeBuddy authenticated page
            # (home, profile, dashboard, etc. — means login worked)
            if on_codebuddy and not on_codebuddy_region and not current_path.startswith("/login"):
                codebuddy_auth_pages = ["", "/", "/home", "/profile", "/dashboard", "/index.html"]
                if current_path in codebuddy_auth_pages or current_path.rstrip("/") in codebuddy_auth_pages:
                    progress("auth_complete", f"Authentication successful (landed on {current_path or '/'})!")
                    # Navigate to /started to signal the server that auth is complete
                    # This makes the token available at the poll endpoint
                    started_url = f"{CODEBUDDY_BASE_URL}/started?platform={CODEBUDDY_PLATFORM}&state={state}"
                    try:
                        progress("signal_server", "Signaling server for token...")
                        await page.goto(started_url, wait_until="domcontentloaded", timeout=10000)
                    except Exception as exc:
                        debug(f"Navigate to /started failed: {exc}")
                    auth_success = True
                    break

            # On Google: try email/password FIRST before other handlers
            if on_google:
                at_password = await _is_password_step(page)
                at_email = await _is_email_step(page)

                if at_email and not at_password:
                    if now < email_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    progress("google_email", "Filling Google email...")
                    filled = await _fill_google_email_step(page, email)
                    if filled:
                        email_transition_deadline = time.monotonic() + 6.0
                        progress("google_email_done", "Email submitted")
                        await asyncio.sleep(1.0)
                        continue
                    else:
                        progress("google_email_fail", "Failed to fill email field, retrying...")

                if at_password:
                    if now < password_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    progress("google_password", "Filling Google password...")
                    filled = await _fill_google_password_step(page, password)
                    if filled:
                        password_transition_deadline = time.monotonic() + 8.0
                        progress("google_password_done", "Password submitted")
                        await asyncio.sleep(1.0)
                        continue

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

            # Handle Google G+ ToS (only when on Google)
            if on_google and await _handle_google_gaplustos(page):
                await asyncio.sleep(0.8)
                continue

            # Handle Google consent (only when on Google)
            if on_google and await _handle_google_consent(page):
                await asyncio.sleep(0.8)
                continue

            # Handle region selection
            if on_codebuddy_region:
                if now < region_transition_deadline:
                    await asyncio.sleep(0.4)
                    continue
                region_ok = await _handle_codebuddy_region(page)
                if region_ok:
                    region_transition_deadline = time.monotonic() + 8.0
                    progress("region", "Region set to Singapore")
                    # After region, wait a bit then check if we get redirected
                    await asyncio.sleep(2.0)
                    continue
                await asyncio.sleep(0.8)
                continue

            # Handle CodeBuddy landing re-trigger
            if on_codebuddy and current_path.startswith("/login"):
                await _handle_codebuddy_landing(page)
                await asyncio.sleep(0.5)
                continue

            # Handle CodeBuddy /auth/realms/ keycloak pages
            if on_codebuddy and "/auth/realms/" in current_path:
                # Check for "Page has expired" (keycloak session timeout)
                if await _handle_page_expired(page, progress):
                    expired_retries += 1
                    if expired_retries >= MAX_EXPIRED_RETRIES:
                        progress("error", f"Page expired {expired_retries} times, giving up")
                        break
                    await asyncio.sleep(1.0)
                    continue
                # Reset counter when we see a non-expired keycloak page
                expired_retries = 0
                await _handle_codebuddy_landing(page)
                await asyncio.sleep(1.0)
                continue

            # Detect "Page has expired" on any CodeBuddy page
            if on_codebuddy and await _handle_page_expired(page, progress):
                expired_retries += 1
                if expired_retries >= MAX_EXPIRED_RETRIES:
                    progress("error", f"Page expired {expired_retries} times, giving up")
                    break
                await asyncio.sleep(1.0)
                continue

            # Detect blocking (only on Google pages)
            blocking = await _detect_blocking(page) if on_google else None
            if blocking:
                is_headless = os.getenv("HEXOS_HEADLESS", "true").lower() == "true"
                
                if blocking.startswith("hard:"):
                    block_reason = blocking[5:]
                    if not is_headless:
                        progress("challenge", f"Challenge detected: {block_reason} — solve it in the browser window (waiting 120s)...")
                        solved = await _wait_for_challenge_resolved(page, timeout=120)
                        if solved:
                            progress("challenge_solved", "Challenge resolved! Continuing...")
                            continue
                    poll_task.cancel()
                    result_failure(f"Google blocked: {block_reason}. Try with --no-headless to solve manually")
                    return
                
                elif blocking.startswith("soft:"):
                    challenge_type = blocking[5:]
                    if not is_headless:
                        progress("challenge", f"Verification required: {challenge_type} — complete it in the browser window (waiting 120s)...")
                        solved = await _wait_for_challenge_resolved(page, timeout=120)
                        if solved:
                            progress("challenge_solved", "Verification completed! Continuing...")
                            continue
                        poll_task.cancel()
                        result_failure(f"Verification timeout: {challenge_type}")
                        return
                    else:
                        poll_task.cancel()
                        result_failure(f"Verification required: {challenge_type}. Try with --no-headless to solve manually")
                        return

            await _click_continue_button(page)
            await asyncio.sleep(1.0)
        else:
            poll_task.cancel()
            result_failure("Auth loop timeout: did not reach callback in time")
            return

        # Step 3: Get token (may already be done from background poll)
        progress("poll_token", "Getting access token...")
        if poll_task.done():
            token_result = poll_task.result()
        else:
            token_result = await poll_task

        if "error" in token_result:
            # Auth succeeded in browser but token poll failed
            # Retry once with a fresh poll
            progress("poll_retry", "Token poll failed, retrying...")
            token_result = await poll_token(state)

        if "error" in token_result:
            # Token poll failed even after retry — report as failure
            # Do NOT return success with empty tokens (causes broken connections in DB)
            err_msg = token_result.get("error", "Token poll failed")
            progress("poll_failed", f"Token poll failed: {err_msg}")
            result_failure(f"Token poll failed after retry: {err_msg}")
            return

        access_token = token_result["accessToken"]
        refresh_token = token_result["refreshToken"]

        # Step 4: Fetch UID
        progress("fetch_uid", "Fetching user ID...")
        uid = await fetch_uid(access_token)

        # Step 5: Fetch credit info via browser (needs cookie session)
        progress("fetch_credit", "Checking account credits...")
        credit = await fetch_credit_via_page(page)
        if credit:
            remain = credit.get("remainingCredits", 0)
            total = credit.get("totalCredits", 0)
            pkg = credit.get("packageName", "Unknown")
            expires = credit.get("expiresAt", "")
            progress("credit_info", f"Credits: {remain:.0f}/{total:.0f} — {pkg}" + (f" (expires: {expires})" if expires else ""))
        else:
            progress("credit_info", "Could not fetch credit info (will retry via API)")

        # Step 6: Extract web cookies for future credit refresh (without browser)
        web_cookie = ""
        if context:
            web_cookie = await extract_web_cookies(context)
            if web_cookie:
                debug(f"Extracted {len(web_cookie)} chars of web cookies")

        result_success(access_token, refresh_token, uid, credit, web_cookie or None)

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
    parser = argparse.ArgumentParser(description="Hexos CodeBuddy browser login")
    parser.add_argument("--email", required=True, help="Google email")
    parser.add_argument("--password", required=True, help="Google password")
    parser.add_argument("--state", required=True, help="CodeBuddy auth state")
    parser.add_argument("--auth-url", required=True, help="CodeBuddy auth URL")
    args = parser.parse_args()

    await run_login(args.email, args.password, args.state, args.auth_url)


if __name__ == "__main__":
    asyncio.run(main())
