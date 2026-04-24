#!/usr/bin/env python3
"""
Hexos Browser Automation – Qoder Login
Automates Qoder OAuth login via Google using Camoufox (anti-detect browser).

Qoder uses standard OAuth2 with Google:
  1. Navigate to /sso/login/google → redirects to Google OAuth
  2. Automate Google email/password
  3. Google redirects back to /sso/callback/google → Qoder sets session cookies
  4. Use session cookies to get user info from /api/v1/users
  5. Navigate to /device/selectAccounts with nonce → auto-redirects via /device/redirect
  6. Capture redirect_url which contains the device token
  7. Poll openapi.qoder.sh for the security_oauth_token

Usage:
    python qoder_login.py --email user@gmail.com --password secret

Output (JSON lines on stdout):
    {"type": "progress", "step": "...", "message": "..."}
    {"type": "result", "success": true, "accessToken": "...", "refreshToken": "...", "uid": "...", "email": "..."}
    {"type": "error", "error": "..."}
"""

import argparse
import asyncio
import base64
import hashlib
import json
import os
import secrets
import ssl
import sys
import time
import uuid
from urllib.parse import parse_qs, urlencode, urlparse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

QODER_BASE = "https://qoder.com"
QODER_SSO_GOOGLE = f"{QODER_BASE}/sso/login/google"
QODER_USERS_API = f"{QODER_BASE}/api/v1/users"
QODER_DEVICE_SELECT = f"{QODER_BASE}/device/selectAccounts"
QODER_DEVICE_REDIRECT = f"{QODER_BASE}/device/redirect"

AUTH_LOOP_MAX_ITERATIONS = 150
DEBUG = os.getenv("HEXOS_DEBUG", "false").lower() == "true"

# SSL context that skips verification (for proxied environments)
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

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


def result_success(
    access_token: str,
    refresh_token: str = "",
    uid: str = "",
    email: str = "",
    name: str = "",
):
    data = {
        "type": "result",
        "success": True,
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "uid": uid,
        "email": email,
        "name": name,
    }
    emit(data)


def result_failure(message: str):
    emit({"type": "result", "success": False, "error": message})


# ---------------------------------------------------------------------------
# PKCE helpers (for device flow)
# ---------------------------------------------------------------------------


def generate_pkce_pair() -> tuple[str, str]:
    """Generate PKCE code_verifier and code_challenge (S256)."""
    code_verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


# ---------------------------------------------------------------------------
# Google OAuth form helpers
# Uses query_selector + is_visible (NOT page.evaluate — hangs in Camoufox)
# ---------------------------------------------------------------------------


async def _is_email_step(page) -> bool:
    """Detect Google email input step."""
    try:
        for sel in ["#identifierId", 'input[type="email"]', 'input[name="identifier"]']:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                return True
    except Exception:
        pass
    return False


async def _is_password_step(page) -> bool:
    """Detect Google password input step."""
    try:
        for sel in ['input[name="Passwd"]', 'input[type="password"]']:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                return True
    except Exception:
        pass
    return False


async def _click_google_next(page) -> bool:
    """Click the Google Next/Submit button."""
    for sel in [
        "#identifierNext button",
        "#passwordNext button",
        "#identifierNext",
        "#passwordNext",
    ]:
        try:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                await el.click(force=True)
                return True
        except Exception:
            continue
    return False


async def _fill_google_email(page, email: str) -> bool:
    """Fill Google email and submit."""
    selectors = [
        "#identifierId",
        'input[type="email"]',
        'input[name="identifier"]',
        'input[autocomplete="username"]',
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
        debug("No email input found after waiting")
        return False

    try:
        locator = page.locator(found_selector).first
        if await locator.count() == 0 or not await locator.is_visible():
            return False

        await locator.scroll_into_view_if_needed()
        await locator.click(force=True)
        await asyncio.sleep(0.2)

        # Clear existing text
        try:
            await locator.press("Control+a")
            await locator.press("Backspace")
        except Exception:
            pass

        # Type email
        await locator.press_sequentially(email, delay=60)
        await asyncio.sleep(0.5)

        # Verify
        value = await locator.input_value()
        if email.lower() != str(value).lower().strip():
            debug(f"Email mismatch: typed={value!r}")
            return False

        await asyncio.sleep(0.3)

        # Click Next
        clicked = await _click_google_next(page)
        if not clicked:
            await locator.press("Enter")

        # Wait for transition
        try:
            await page.wait_for_selector(
                'input[name="Passwd"], input[type="password"]',
                state="visible",
                timeout=10000,
            )
        except Exception:
            await asyncio.sleep(2.0)

        return True
    except Exception as exc:
        debug(f"Email fill error: {exc}")
        return False


async def _fill_google_password(page, password: str) -> bool:
    """Fill Google password and submit."""
    selectors = ['input[name="Passwd"]', 'input[type="password"]']

    found_selector = None
    for selector in selectors:
        try:
            await page.wait_for_selector(selector, state="visible", timeout=5000)
            found_selector = selector
            break
        except Exception:
            continue

    if not found_selector:
        debug("No password input found after waiting")
        return False

    try:
        locator = page.locator(found_selector).first
        if await locator.count() == 0 or not await locator.is_visible():
            return False

        await locator.scroll_into_view_if_needed()
        await locator.click(force=True)
        await asyncio.sleep(0.2)

        # Clear
        try:
            await locator.press("Control+a")
            await locator.press("Backspace")
        except Exception:
            pass

        # Type password
        await locator.press_sequentially(password, delay=70)
        await asyncio.sleep(0.5)

        # Click Next
        clicked = await _click_google_next(page)
        if not clicked:
            await locator.press("Enter")

        # Wait for transition
        try:
            await page.wait_for_function(
                """() => {
                    const host = window.location.host || '';
                    const path = window.location.pathname || '';
                    const hasPwd = Array.from(
                        document.querySelectorAll('input[name="Passwd"], input[type="password"]')
                    ).some(el => el.offsetParent !== null);
                    if (!host.includes('accounts.google.com')) return true;
                    if (!path.includes('/challenge/pwd')) return true;
                    return !hasPwd;
                }""",
                timeout=12000,
            )
        except Exception:
            await asyncio.sleep(3.0)

        return True
    except Exception as exc:
        debug(f"Password fill error: {exc}")
        return False


async def _handle_google_consent(page) -> bool:
    """Handle Google consent/continue page."""
    try:
        current_url = page.url
        if "accounts.google.com" not in current_url:
            return False
        parsed = urlparse(current_url)
        path = parsed.path.lower()
        if "/signin/identifier" in path or "/challenge/pwd" in path:
            return False

        for text in ["Continue", "Allow", "Lanjutkan", "I agree", "Izinkan"]:
            try:
                btn = page.get_by_text(text, exact=False).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    await asyncio.sleep(1.0)
                    return True
            except Exception:
                continue
    except Exception:
        pass
    return False


async def _handle_google_gaplustos(page) -> bool:
    """Handle Google G+ ToS page."""
    try:
        current_url = page.url
        if "/speedbump/gaplustos" not in current_url:
            return False

        for sel in ["#confirm", 'input[name="confirm"]', 'input[type="submit"]']:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                await el.click(force=True)
                debug(f"gaplustos clicked: {sel}")
                return True

        for text in ["I understand", "Saya mengerti"]:
            try:
                btn = page.get_by_text(text, exact=False).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    return True
            except Exception:
                continue
    except Exception:
        pass
    return False


async def _click_continue_button(page) -> bool:
    """Click any generic continue/next/accept button."""
    try:
        for text in ["Next", "Continue", "Accept", "OK", "Got it", "Sign in", "Login"]:
            try:
                btn = page.get_by_text(text, exact=False).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    return True
            except Exception:
                continue
    except Exception:
        pass
    return False


async def _detect_blocking(page) -> str | None:
    """Detect Google blocking challenges."""
    try:
        current_url = page.url
        if "accounts.google.com" not in current_url:
            return None

        parsed = urlparse(current_url)
        path = parsed.path

        if "/challenge/" in path:
            normal_paths = ["/challenge/pwd", "/challenge/selection", "/challenge/ipp"]
            for np in normal_paths:
                if np in path:
                    return None
            return f"soft:google challenge ({path})"

        # reCAPTCHA challenge is solvable manually — treat as soft
        if "/challenge/recaptcha" in path:
            return "soft:reCAPTCHA challenge"

        markers = [
            ("try again later", "hard:rate_limited"),
            ("this browser or app may not be secure", "hard:browser_blocked"),
            ("unusual traffic", "hard:unusual_traffic"),
        ]
        for keyword, result in markers:
            try:
                loc = page.get_by_text(keyword, exact=False).first
                if await loc.count() > 0 and await loc.is_visible():
                    return result
            except Exception:
                continue
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Qoder-specific: extract tokens after login
# ---------------------------------------------------------------------------


async def _get_cookies_string(page) -> str:
    """Extract qoder.com cookies from browser context."""
    try:
        context = page.context
        cookies = await context.cookies()
        debug(f"Browser cookies: {len(cookies)} total")
        qoder_cookies = [c for c in cookies if "qoder" in (c.get("domain", "") or "")]
        cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in qoder_cookies)
        debug(f"Qoder cookies: {cookie_str[:100]}...")
        return cookie_str
    except Exception as exc:
        debug(f"Cookie extraction error: {exc}")
        return ""


async def _get_csrf_token(cookies: str) -> str:
    """Extract CSRF token from cookies."""
    for part in cookies.split(";"):
        part = part.strip()
        if part.startswith("qoder_csrf_token="):
            return part.split("=", 1)[1]
    return ""


async def _get_user_info(cookies: str) -> dict | None:
    """Call GET /api/v1/me with session cookies to get user info."""
    import aiohttp

    try:
        if not cookies:
            return None

        csrf = await _get_csrf_token(cookies)
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            headers = {
                "Cookie": cookies,
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            }
            if csrf:
                headers["X-CSRF-Token"] = csrf

            async with session.get(
                f"{QODER_BASE}/api/v1/me",
                headers=headers,
                ssl=_SSL_CTX,
            ) as resp:
                body = await resp.text()
                debug(f"/api/v1/me status={resp.status} body={body[:300]}")

                if resp.status != 200:
                    return None

                data = json.loads(body)
                return {
                    "uid": data.get("id") or data.get("uid") or "",
                    "email": data.get("email") or "",
                    "name": data.get("name") or "",
                    "avatar": data.get("avatar") or "",
                }
    except Exception as exc:
        debug(f"User info fetch error: {exc}")
        return None


async def _create_personal_access_token_via_page(page, token_name: str = "hexos") -> dict | None:
    """Create a Personal Access Token by navigating to the PAT page and using fetch() with proper CSRF."""
    import aiohttp

    try:
        # First, navigate to the PAT settings page to get proper CSRF context
        progress("pat_navigate", "Navigating to access token settings...")
        await page.goto(f"{QODER_BASE}/account/access-tokens", wait_until="domcontentloaded", timeout=20000)
        await asyncio.sleep(3.0)

        # Get cookies after page load (CSRF token should be fresh)
        cookie_str = await _get_cookies_string(page)
        csrf = await _get_csrf_token(cookie_str)
        debug(f"CSRF token from cookies: {csrf[:20]}..." if csrf else "No CSRF token in cookies")

        # Try to find CSRF token from meta tag or page content
        if not csrf:
            try:
                meta = await page.query_selector('meta[name="csrf-token"]')
                if meta:
                    csrf = await meta.get_attribute("content") or ""
                    debug(f"CSRF from meta tag: {csrf[:20]}...")
            except Exception:
                pass

        # Use aiohttp with the session cookies to create PAT
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            headers = {
                "Cookie": cookie_str,
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Origin": QODER_BASE,
                "Referer": f"{QODER_BASE}/account/access-tokens",
            }
            if csrf:
                headers["X-CSRF-Token"] = csrf

            async with session.post(
                f"{QODER_BASE}/api/v1/me/personal-access-tokens",
                headers=headers,
                json={"name": token_name},
                ssl=_SSL_CTX,
            ) as resp:
                body = await resp.text()
                debug(f"Create PAT status={resp.status} body={body[:300]}")

                if resp.status not in (200, 201):
                    debug(f"PAT creation failed with aiohttp: {body[:200]}")

                    # Fallback: try using page.evaluate to make the request
                    # (this uses the browser's own cookies and CSRF handling)
                    debug("Trying PAT creation via page fetch...")
                    try:
                        # Use route interception to capture the response
                        pat_response = {"data": None}

                        async def capture_pat(route):
                            response = await route.fetch()
                            body_bytes = await response.body()
                            try:
                                pat_response["data"] = json.loads(body_bytes.decode("utf-8"))
                            except Exception:
                                pass
                            await route.fulfill(response=response)

                        await page.route("**/api/v1/me/personal-access-tokens", capture_pat)

                        # Click "Create Token" button if it exists
                        for text in ["Create Token", "Create", "New Token", "Generate"]:
                            try:
                                btn = page.get_by_text(text, exact=False).first
                                if await btn.count() > 0 and await btn.is_visible():
                                    await btn.click()
                                    debug(f"Clicked '{text}' button")
                                    await asyncio.sleep(2.0)
                                    break
                            except Exception:
                                continue

                        # Fill token name if there's an input
                        try:
                            name_input = await page.query_selector('input[placeholder*="name" i], input[placeholder*="token" i], input[type="text"]')
                            if name_input and await name_input.is_visible():
                                await name_input.fill(token_name)
                                await asyncio.sleep(0.5)
                                # Click submit/create
                                for text in ["Create", "Generate", "OK", "Submit", "Confirm"]:
                                    try:
                                        btn = page.get_by_text(text, exact=False).first
                                        if await btn.count() > 0 and await btn.is_visible():
                                            await btn.click()
                                            debug(f"Clicked submit '{text}'")
                                            await asyncio.sleep(3.0)
                                            break
                                    except Exception:
                                        continue
                        except Exception:
                            pass

                        await page.unroute("**/api/v1/me/personal-access-tokens")

                        if pat_response["data"]:
                            return pat_response["data"]
                    except Exception as exc:
                        debug(f"Page-based PAT creation error: {exc}")

                    return None

                data = json.loads(body)
                return data
    except Exception as exc:
        debug(f"PAT creation error: {exc}")
        return None


async def _get_device_token_via_browser(page, nonce: str, code_verifier: str) -> dict | None:
    """
    Navigate to /device/selectAccounts with nonce, let the page auto-call
    /device/redirect, and capture the redirect_url containing the token.
    """
    try:
        # Build device select URL with PKCE
        code_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode("ascii")).digest()
        ).rstrip(b"=").decode("ascii")

        params = {
            "nonce": nonce,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "directLogin": "true",
        }
        device_url = f"{QODER_DEVICE_SELECT}?{urlencode(params)}"
        debug(f"Device URL: {device_url}")

        # Capture the redirect URL from /device/redirect response
        redirect_url = None

        async def on_response(response):
            nonlocal redirect_url
            if redirect_url:
                return
            try:
                url = response.url
                if "/device/redirect" in url and response.status == 200:
                    body = await response.text()
                    debug(f"Device redirect response: {body[:300]}")
                    data = json.loads(body)
                    if data.get("redirect_url"):
                        redirect_url = data["redirect_url"]
                        debug(f"Got redirect URL: {redirect_url[:200]}")
            except Exception as exc:
                debug(f"Response handler error: {exc}")

        page.on("response", on_response)

        progress("device_flow", "Navigating to device authorization page...")
        await page.goto(device_url, wait_until="domcontentloaded", timeout=30000)

        # Wait for the redirect to happen (page JS calls /device/redirect automatically
        # when directLogin=true and user is already logged in)
        for _ in range(30):
            if redirect_url:
                break
            await asyncio.sleep(1.0)

        if not redirect_url:
            # Try clicking "Continue" button if directLogin didn't auto-redirect
            progress("device_flow", "Clicking Continue button...")
            try:
                for text in ["Continue", "Lanjutkan", "Confirm", "OK"]:
                    btn = page.get_by_text(text, exact=False).first
                    if await btn.count() > 0 and await btn.is_visible():
                        await btn.click()
                        debug(f"Clicked '{text}' button")
                        break
            except Exception:
                pass

            # Wait more for redirect
            for _ in range(20):
                if redirect_url:
                    break
                await asyncio.sleep(1.0)

        if not redirect_url:
            debug("No redirect URL captured from device flow")
            return None

        # Parse the redirect URL for token info
        parsed = urlparse(redirect_url)
        params = parse_qs(parsed.query)
        debug(f"Redirect params: {list(params.keys())}")

        return {
            "redirect_url": redirect_url,
            "params": {k: v[0] if len(v) == 1 else v for k, v in params.items()},
        }
    except Exception as exc:
        debug(f"Device token error: {exc}")
        return None


async def _poll_device_token(nonce: str, code_verifier: str, max_wait: float = 30.0) -> dict | None:
    """Poll openapi.qoder.sh for the device token after browser approval."""
    import aiohttp

    start = time.monotonic()
    poll_url = "https://openapi.qoder.sh/api/v1/deviceToken/poll"

    while time.monotonic() - start < max_wait:
        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                params = {"nonce": nonce, "verifier": code_verifier}
                async with session.get(
                    poll_url,
                    params=params,
                    ssl=_SSL_CTX,
                ) as resp:
                    body = await resp.text()
                    debug(f"Poll status={resp.status} body={body[:200]}")

                    if resp.status == 200:
                        data = json.loads(body)
                        # Check if we got a token
                        if data.get("data") and isinstance(data["data"], dict):
                            token_data = data["data"]
                            if token_data.get("security_oauth_token") or token_data.get("token"):
                                return token_data
                        # Check top-level
                        if data.get("security_oauth_token") or data.get("token"):
                            return data
        except Exception as exc:
            debug(f"Poll error: {exc}")

        await asyncio.sleep(1.5)

    return None


# ---------------------------------------------------------------------------
# Main login flow
# ---------------------------------------------------------------------------


async def run_login(email: str, password: str):
    """Run the full Qoder OAuth login flow via Google."""
    browser = None
    manager = None

    try:
        from browserforge.fingerprints import Screen
        from camoufox.async_api import AsyncCamoufox
    except ImportError as exc:
        result_failure(f"Missing dependency: {exc}. Run: pip install camoufox browserforge")
        return

    try:
        # Step 1: Generate PKCE pair for device flow
        code_verifier, code_challenge = generate_pkce_pair()
        nonce = secrets.token_hex(16)
        debug(f"PKCE: verifier={code_verifier[:20]}... nonce={nonce}")

        # Step 2: Build SSO URL
        # oauth_callback points to /device/selectAccounts so after Google login,
        # user lands on the device page which auto-approves
        device_params = urlencode({
            "nonce": nonce,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "directLogin": "true",
        })
        oauth_callback = f"{QODER_DEVICE_SELECT}?{device_params}"
        sso_url = f"{QODER_SSO_GOOGLE}?oauth_callback={urlencode({'': oauth_callback})[1:]}"
        debug(f"SSO URL: {sso_url[:200]}...")

        # Step 3: Launch browser
        progress("browser", "Launching browser...")

        is_headless = os.getenv("HEXOS_HEADLESS", "true").lower() == "true"
        camoufox_kwargs = {
            "headless": is_headless,
            "os": "windows",
            "block_webrtc": True,
            "humanize": False,
            "screen": Screen(max_width=1920, max_height=1080),
            "i_know_what_im_doing": True,
        }

        proxy_url = os.getenv("HEXOS_PROXY") or os.getenv("HTTP_PROXY") or ""
        if proxy_url:
            parsed = urlparse(proxy_url)
            proxy_cfg = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
            if parsed.username:
                proxy_cfg["username"] = parsed.username
            if parsed.password:
                proxy_cfg["password"] = parsed.password
            camoufox_kwargs["proxy"] = proxy_cfg
            progress("proxy", f"Using proxy: {proxy_url}")

        manager = AsyncCamoufox(**camoufox_kwargs)
        browser = await manager.__aenter__()
        page = await browser.new_page()
        page.set_default_timeout(20000)

        # Step 4: Navigate to Qoder SSO (Google login)
        progress("navigate", "Navigating to Qoder login page...")
        debug(f"Navigating to: {sso_url[:200]}")
        try:
            await page.goto(sso_url, wait_until="domcontentloaded", timeout=30000)
        except Exception as nav_exc:
            debug(f"First navigation failed: {nav_exc}, retrying...")
            progress("navigate_retry", "Navigation failed, retrying...")
            await asyncio.sleep(2.0)
            try:
                await page.goto(sso_url, wait_until="domcontentloaded", timeout=30000)
            except Exception as nav_exc2:
                result_failure(f"Navigation failed: {nav_exc2}")
                return
        await asyncio.sleep(2.0)

        # Step 5: Auth loop — automate Google login
        progress("auth_loop", "Automating Google login...")
        page.set_default_timeout(5000)

        email_transition_deadline = 0.0
        password_transition_deadline = 0.0
        email_step_started_at = None
        landed_on_qoder = False
        device_token_result = None

        # Track if we've captured the device redirect
        redirect_url_captured = None

        async def on_response(response):
            nonlocal redirect_url_captured
            if redirect_url_captured:
                return
            try:
                url = response.url
                if "/device/redirect" in url and response.status == 200:
                    body = await response.text()
                    debug(f"Device redirect response: {body[:300]}")
                    data = json.loads(body)
                    if data.get("redirect_url"):
                        redirect_url_captured = data["redirect_url"]
                        debug(f"Captured redirect URL: {redirect_url_captured[:200]}")
            except Exception:
                pass

        page.on("response", on_response)

        for iteration in range(AUTH_LOOP_MAX_ITERATIONS):
            try:
                current_url = page.url
            except Exception:
                current_url = ""

            parsed_url = urlparse(current_url) if current_url else None
            current_host = parsed_url.netloc if parsed_url else ""
            current_path = parsed_url.path if parsed_url else ""
            on_google = "accounts.google.com" in current_host
            on_qoder = "qoder.com" in current_host
            now = time.monotonic()

            # Debug URL changes
            if iteration % 10 == 0:
                debug(f"Iteration {iteration}: url={current_url[:120]}")

            # Check if we captured the device redirect
            if redirect_url_captured:
                progress("device_redirect", "Device authorization redirect captured!")
                break

            # Check if we landed on Qoder after Google login
            if on_qoder and not landed_on_qoder and not on_google:
                # Check if we're on the device/selectAccounts page
                if "/device/selectAccounts" in current_path or "/device/" in current_path:
                    landed_on_qoder = True
                    progress("qoder_landed", "Landed on Qoder device page, waiting for auto-redirect...")
                    # The page JS should auto-call /device/redirect when directLogin=true
                    # Wait for it
                    for _ in range(30):
                        if redirect_url_captured:
                            break
                        await asyncio.sleep(1.0)
                        # Also try clicking Continue if needed
                        try:
                            for text in ["Continue", "Lanjutkan"]:
                                btn = page.get_by_text(text, exact=False).first
                                if await btn.count() > 0 and await btn.is_visible():
                                    await btn.click()
                                    debug(f"Clicked '{text}'")
                                    break
                        except Exception:
                            pass
                    break

                elif "/account/" in current_path or "/LoginCallback" in current_url:
                    landed_on_qoder = True
                    progress("qoder_logged_in", "Logged into Qoder, navigating to device page...")
                    # Navigate to device page
                    device_url = f"{QODER_DEVICE_SELECT}?{device_params}"
                    await page.goto(device_url, wait_until="domcontentloaded", timeout=30000)
                    await asyncio.sleep(3.0)
                    # Wait for redirect
                    for _ in range(30):
                        if redirect_url_captured:
                            break
                        await asyncio.sleep(1.0)
                        try:
                            for text in ["Continue", "Lanjutkan"]:
                                btn = page.get_by_text(text, exact=False).first
                                if await btn.count() > 0 and await btn.is_visible():
                                    await btn.click()
                                    debug(f"Clicked '{text}'")
                                    break
                        except Exception:
                            pass
                    break

            # Skip SetSID redirects
            if "SetSID" in current_url or "/accounts/set" in current_url.lower():
                await asyncio.sleep(0.5)
                continue

            # Google auth steps
            if on_google:
                at_password = await _is_password_step(page)
                at_email = await _is_email_step(page)

                if at_email and not at_password:
                    if email_step_started_at is None:
                        email_step_started_at = now
                    elif now - email_step_started_at > 60.0:
                        result_failure("Google email step stuck > 60s (possible captcha)")
                        return

                    if now < email_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue

                    progress("google_email", "Filling Google email...")
                    if await _fill_google_email(page, email):
                        email_transition_deadline = time.monotonic() + 6.0
                        progress("google_email_done", "Email submitted")
                        await asyncio.sleep(1.0)
                        continue

                if at_password:
                    email_step_started_at = None
                    if now < password_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue

                    progress("google_password", "Filling Google password...")
                    if await _fill_google_password(page, password):
                        password_transition_deadline = time.monotonic() + 8.0
                        progress("google_password_done", "Password submitted")
                        await asyncio.sleep(1.0)
                        continue

                if at_email or at_password:
                    await asyncio.sleep(0.6)
                    continue

            # Handle Google G+ ToS
            if on_google and await _handle_google_gaplustos(page):
                await asyncio.sleep(0.8)
                continue

            # Handle Google consent
            if on_google and await _handle_google_consent(page):
                await asyncio.sleep(0.8)
                continue

            # Detect blocking
            if on_google:
                blocking = await _detect_blocking(page)
                if blocking:
                    is_headless_env = os.getenv("HEXOS_HEADLESS", "true").lower() == "true"
                    if blocking.startswith("hard:"):
                        result_failure(f"Google blocked: {blocking[5:]}. Try with --no-headless")
                        return
                    elif blocking.startswith("soft:"):
                        if not is_headless_env:
                            progress("challenge", f"Challenge detected: {blocking[5:]} — solve in browser (180s)...")
                            for _ in range(360):
                                await asyncio.sleep(0.5)
                                if redirect_url_captured:
                                    break
                                new_url = page.url
                                if "accounts.google.com" not in new_url or "/challenge/" not in new_url:
                                    progress("challenge_solved", "Challenge resolved!")
                                    break
                            else:
                                result_failure(f"Challenge timeout: {blocking[5:]}")
                                return
                            continue
                        else:
                            result_failure(f"Verification required: {blocking[5:]}. Try with --no-headless")
                            return

            # Generic continue
            await _click_continue_button(page)
            await asyncio.sleep(1.0)
        else:
            # Loop exhausted without breaking
            if not redirect_url_captured and not landed_on_qoder:
                result_failure("Auth loop timeout: did not complete Google login")
                return

        # Step 6: Extract token via session cookies
        progress("extract_token", "Extracting session cookies...")
        cookie_str = await _get_cookies_string(page)

        if not cookie_str:
            result_failure("No Qoder session cookies found after login")
            return

        # Step 7: Get user info
        progress("user_info", "Fetching user info...")
        user_info = await _get_user_info(cookie_str)

        if not user_info or not user_info.get("uid"):
            debug("Could not get user info from /api/v1/me")
            # Try alternate: maybe we need to wait for the page to fully load
            await asyncio.sleep(3.0)
            cookie_str = await _get_cookies_string(page)
            user_info = await _get_user_info(cookie_str)

        if not user_info or not user_info.get("uid"):
            result_failure("Could not get user info from Qoder session")
            return

        uid = user_info["uid"]
        email_addr = user_info.get("email", "")
        name = user_info.get("name", "")
        progress("user_info_ok", f"User: {email_addr or name or uid}")

        # Step 8: Create Personal Access Token via browser page
        # Use Playwright's APIRequestContext which shares browser cookies
        progress("create_pat", "Creating personal access token...")

        pat_name = f"hexos-{secrets.token_hex(4)}"
        pat_token = None

        try:
            # Navigate to access tokens page first to establish CSRF context
            await page.goto(f"{QODER_BASE}/account/access-tokens", wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(4.0)

            # Intercept ALL API responses to find CSRF token pattern
            pat_response_data = {"result": None}
            csrf_token_found = {"value": None}

            async def capture_responses(response):
                try:
                    url = response.url
                    # Capture PAT creation response
                    if "/api/v1/me/personal-access-tokens" in url:
                        body = await response.text()
                        debug(f"PAT API [{response.request.method}] {response.status}: {body[:300]}")
                        if response.request.method == "POST" and response.status in (200, 201):
                            pat_response_data["result"] = json.loads(body)
                        elif response.request.method == "GET" and response.status == 200:
                            debug(f"Existing PATs: {body[:200]}")
                except Exception:
                    pass

            page.on("response", capture_responses)

            # Check if there are existing PATs listed
            await asyncio.sleep(2.0)

            # Take screenshot for debugging
            debug(f"Current URL: {page.url}")

            # Look for "Create" button — Qoder uses Ant Design
            clicked_create = False
            # Try button selectors first
            for sel in ['button:has-text("Create")', 'button:has-text("New")', 'button:has-text("Generate")', '.ant-btn-primary']:
                try:
                    el = await page.query_selector(sel)
                    if el and await el.is_visible():
                        await el.click()
                        debug(f"Clicked button: {sel}")
                        clicked_create = True
                        await asyncio.sleep(2.0)
                        break
                except Exception:
                    continue

            if not clicked_create:
                # Try text-based
                for text in ["Create", "New Token", "Generate", "Create Token"]:
                    try:
                        btn = page.get_by_role("button", name=text)
                        if await btn.count() > 0 and await btn.is_visible():
                            await btn.click()
                            debug(f"Clicked button by role: '{text}'")
                            clicked_create = True
                            await asyncio.sleep(2.0)
                            break
                    except Exception:
                        continue

            if clicked_create:
                # Fill token name in modal/dialog
                await asyncio.sleep(1.5)
                filled = False
                for sel in [
                    '.ant-modal input[type="text"]',
                    '.ant-drawer input[type="text"]',
                    'input[placeholder*="name" i]',
                    'input[placeholder*="token" i]',
                    '#name',
                    '.ant-input',
                ]:
                    try:
                        inp = await page.query_selector(sel)
                        if inp and await inp.is_visible():
                            await inp.click()
                            await inp.fill(pat_name)
                            debug(f"Filled token name in: {sel}")
                            filled = True
                            await asyncio.sleep(0.5)
                            break
                    except Exception:
                        continue

                if not filled:
                    debug("Could not find input for token name")

                # Click OK/Create/Confirm in modal
                await asyncio.sleep(0.5)
                for sel in [
                    '.ant-modal .ant-btn-primary',
                    '.ant-drawer .ant-btn-primary',
                    'button:has-text("OK")',
                    'button:has-text("Create")',
                    'button:has-text("Confirm")',
                ]:
                    try:
                        el = await page.query_selector(sel)
                        if el and await el.is_visible():
                            await el.click()
                            debug(f"Clicked confirm: {sel}")
                            await asyncio.sleep(3.0)
                            break
                    except Exception:
                        continue

                # Wait for response
                for _ in range(15):
                    if pat_response_data["result"]:
                        break
                    await asyncio.sleep(1.0)

            if pat_response_data["result"]:
                data = pat_response_data["result"]
                debug(f"PAT result keys: {list(data.keys())}")
                pat_token = (
                    data.get("token")
                    or data.get("access_token")
                    or data.get("security_oauth_token")
                    or data.get("value")
                    or data.get("plainTextToken")
                    or data.get("pat")
                    or ""
                )
                debug(f"PAT token: {pat_token[:30]}..." if pat_token else "PAT token: EMPTY")

            # Also check if token is shown on the page
            if not pat_token:
                try:
                    for sel in ['code', 'pre', '.token-value', '.ant-typography-copy', 'span.ant-typography']:
                        els = await page.query_selector_all(sel)
                        for el in els:
                            if await el.is_visible():
                                text_content = (await el.text_content() or "").strip()
                                if text_content and (text_content.startswith("pat_") or text_content.startswith("dt-") or len(text_content) > 40):
                                    pat_token = text_content
                                    debug(f"Token from page ({sel}): {pat_token[:30]}...")
                                    break
                        if pat_token:
                            break
                except Exception:
                    pass

        except Exception as exc:
            debug(f"PAT creation error: {exc}")

        if pat_token:
            progress("token_ok", f"Personal access token created for {email_addr or uid}")
            result_success(pat_token, "", uid, email_addr, name)
            return

        # Step 9: Fallback — try device token polling
        progress("poll_token", "PAT creation failed, trying device token poll...")
        poll_result = await _poll_device_token(nonce, code_verifier, max_wait=10.0)

        if poll_result:
            token = poll_result.get("security_oauth_token") or poll_result.get("token") or ""
            refresh = poll_result.get("refresh_token") or ""
            if token:
                progress("token_ok", f"Device token obtained for {email_addr or uid}")
                result_success(token, refresh, uid, email_addr, name)
                return

        # Step 10: Last resort — check cookies for token
        progress("cookie_check", "Checking cookies for token...")
        try:
            context = page.context
            cookies = await context.cookies()
            for c in cookies:
                if "qoder" in (c.get("domain", "") or ""):
                    cname = c.get("name", "")
                    cvalue = c.get("value", "")
                    if cname in ("security_oauth_token", "token", "access_token") or cvalue.startswith("dt-"):
                        progress("token_ok", f"Token found in cookie: {cname}")
                        result_success(cvalue, "", uid, email_addr, name)
                        return
                    debug(f"Cookie: {cname}={cvalue[:40]}...")
        except Exception as exc:
            debug(f"Cookie scan error: {exc}")

        result_failure(
            f"Logged in as {email_addr or uid} but could not create access token. "
            "PAT creation and device polling both failed."
        )

    except Exception as exc:
        result_failure(f"Browser automation error: {exc}")
    finally:
        if browser and manager:
            try:
                await manager.__aexit__(None, None, None)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main():
    parser = argparse.ArgumentParser(description="Hexos Qoder browser login")
    parser.add_argument("--email", required=True, help="Google email")
    parser.add_argument("--password", required=True, help="Google password")
    args = parser.parse_args()

    await run_login(args.email, args.password)


if __name__ == "__main__":
    asyncio.run(main())
