#!/usr/bin/env python3
"""
Hexos Browser Automation – Kiro Login
Automates Kiro OAuth PKCE login via Google using Camoufox (anti-detect browser).

Kiro uses AWS Cognito social login with PKCE:
  1. Generate code_verifier + code_challenge (S256)
  2. Open Kiro auth URL → redirects to Google OAuth
  3. Automate Google email/password
  4. Intercept kiro:// redirect to get authorization code
  5. Exchange code for tokens at /oauth/token
  6. Fetch usage/quota from AWS API

Usage:
    python kiro_login.py --email user@gmail.com --password secret

Output (JSON lines on stdout):
    {"type": "progress", "step": "...", "message": "..."}
    {"type": "result", "success": true, "accessToken": "...", "refreshToken": "...", "profileArn": "...", "credit": {...}}
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
from urllib.parse import parse_qs, urlencode, urlparse, quote

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

KIRO_AUTH_BASE = "https://prod.us-east-1.auth.desktop.kiro.dev"
KIRO_LOGIN_ENDPOINT = f"{KIRO_AUTH_BASE}/login"
KIRO_TOKEN_ENDPOINT = f"{KIRO_AUTH_BASE}/oauth/token"
KIRO_REFRESH_ENDPOINT = f"https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
KIRO_REDIRECT_URI = "kiro://kiro.kiroAgent/authenticate-success"
KIRO_USAGE_ENDPOINT = "https://q.us-east-1.amazonaws.com/getUsageLimits"

AUTH_LOOP_MAX_ITERATIONS = 120
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
    refresh_token: str,
    profile_arn: str = "",
    credit: dict | None = None,
):
    data = {
        "type": "result",
        "success": True,
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "profileArn": profile_arn,
    }
    if credit:
        data["credit"] = credit
    emit(data)


def result_failure(message: str):
    emit({"type": "result", "success": False, "error": message})


# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------


def generate_pkce_pair() -> tuple[str, str]:
    """Generate PKCE code_verifier and code_challenge (S256)."""
    code_verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


def extract_code_from_kiro_url(url: str) -> str | None:
    """Extract authorization code from kiro:// redirect URL."""
    if not url.startswith("kiro://"):
        return None
    params = parse_qs(urlparse(url).query)
    values = params.get("code")
    return values[0] if values else None


# ---------------------------------------------------------------------------
# Google OAuth form helpers
# Ported from login.py (CodeBuddy) — proven working approach.
# Uses wait_for_selector + Locator API consistently.
# Does NOT use page.evaluate() (hangs in Camoufox).
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
    """Click the Google Next/Submit button. Tries multiple selectors."""
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
    """Fill Google email and submit. Uses wait_for_selector for reliability."""
    selectors = [
        "#identifierId",
        'input[type="email"]',
        'input[name="identifier"]',
        'input[autocomplete="username"]',
    ]

    # Wait for any email input to become visible
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

        # Wait for transition (password field appears or email field disappears)
        try:
            await page.wait_for_selector(
                'input[name="Passwd"], input[type="password"]',
                state="visible",
                timeout=10000,
            )
        except Exception:
            # May have transitioned to something else (account picker, consent, etc.)
            await asyncio.sleep(2.0)

        return True
    except Exception as exc:
        debug(f"Email fill error: {exc}")
        return False


async def _fill_google_password(page, password: str) -> bool:
    """Fill Google password and submit. Uses wait_for_selector for reliability."""
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

        # Wait for transition (leave Google or reach consent/challenge)
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
    """Handle Google consent/continue page. Only runs on consent-specific URLs."""
    try:
        current_url = page.url
        if "accounts.google.com" not in current_url:
            return False
        # Only handle actual consent pages, not email/password pages
        parsed = urlparse(current_url)
        path = parsed.path.lower()
        if "/signin/identifier" in path or "/challenge/pwd" in path:
            return False

        for text in ["Continue", "Allow", "Lanjutkan", "I agree"]:
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
    """Detect Google blocking challenges. Excludes normal auth paths."""
    try:
        current_url = page.url
        if "accounts.google.com" not in current_url:
            return None

        parsed = urlparse(current_url)
        path = parsed.path

        # Check for challenge paths, but EXCLUDE normal auth steps
        if "/challenge/" in path:
            normal_paths = ["/challenge/pwd", "/challenge/selection", "/challenge/ipp"]
            for np in normal_paths:
                if np in path:
                    return None  # Normal auth step, not a block
            return f"soft:google challenge ({path})"

        # Check page text for blocking markers
        markers = [
            ("captcha", "hard:captcha"),
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
# Token exchange & usage
# ---------------------------------------------------------------------------


async def exchange_code_for_tokens(code: str, code_verifier: str) -> dict:
    """Exchange authorization code for access/refresh tokens."""
    import aiohttp

    try:
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                KIRO_TOKEN_ENDPOINT,
                json={
                    "code": code,
                    "code_verifier": code_verifier,
                    "redirect_uri": KIRO_REDIRECT_URI,
                },
                headers={"Content-Type": "application/json"},
                ssl=_SSL_CTX,
            ) as resp:
                body = await resp.text()
                debug(f"Token exchange status={resp.status} body={body[:200]}")

                if resp.status != 200:
                    return {"error": f"Token exchange failed ({resp.status}): {body[:200]}"}

                payload = json.loads(body)
                access_token = payload.get("accessToken", "")
                refresh_token = payload.get("refreshToken", "")
                profile_arn = str(payload.get("profileArn") or "").strip()

                if not access_token:
                    return {"error": "Token response missing accessToken"}

                result = {
                    "access_token": access_token,
                    "refresh_token": refresh_token,
                }
                if profile_arn:
                    result["profile_arn"] = profile_arn
                if payload.get("expiresIn") is not None:
                    result["expires_in"] = str(payload["expiresIn"])
                return result
    except Exception as exc:
        return {"error": f"Token exchange error: {exc}"}


async def fetch_kiro_usage(access_token: str, profile_arn: str = "") -> dict | None:
    """Fetch Kiro usage/quota from AWS API."""
    import aiohttp

    params = ["origin=AI_EDITOR", "resourceType=AGENTIC_REQUEST"]
    if profile_arn:
        params.append(f"profileArn={quote(profile_arn, safe='')}")
    url = KIRO_USAGE_ENDPOINT + "?" + "&".join(params)

    try:
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                url,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                    "User-Agent": "kiro-ide/1.0.0",
                },
                ssl=_SSL_CTX,
            ) as resp:
                if resp.status != 200:
                    debug(f"Usage fetch failed: {resp.status}")
                    return None

                payload = await resp.json()
                return _parse_usage(payload)
    except Exception as exc:
        debug(f"Usage fetch error: {exc}")
        return None


def _parse_usage(payload: dict) -> dict:
    """Parse Kiro usage response into credit-like format."""
    usage_list = payload.get("usageBreakdownList") or []
    if not usage_list:
        return {"totalCredits": 0, "remainingCredits": 0, "usedCredits": 0, "packageName": "Free", "expiresAt": ""}

    usage = usage_list[0] or {}
    usage_limit = float(usage.get("usageLimit") or usage.get("usageLimitWithPrecision") or 0)
    current_usage = float(usage.get("currentUsage") or usage.get("currentUsageWithPrecision") or 0)

    # Add free trial bonus
    free_trial = usage.get("freeTrialInfo") or {}
    free_trial_limit = 0.0
    free_trial_usage = 0.0
    if str(free_trial.get("freeTrialStatus") or "").upper() == "ACTIVE":
        free_trial_limit = float(free_trial.get("usageLimit") or free_trial.get("usageLimitWithPrecision") or 0)
        free_trial_usage = float(free_trial.get("currentUsage") or free_trial.get("currentUsageWithPrecision") or 0)

    # Add bonuses
    bonus_limit = 0.0
    bonus_usage = 0.0
    for bonus in usage.get("bonuses") or []:
        bonus_limit += float((bonus or {}).get("usageLimit") or 0)
        bonus_usage += float((bonus or {}).get("currentUsage") or 0)

    total = usage_limit + free_trial_limit + bonus_limit
    used = current_usage + free_trial_usage + bonus_usage
    remaining = max(total - used, 0)

    sub_title = str(
        payload.get("subscriptionInfo", {}).get("subscriptionTitle")
        or payload.get("subscriptionTitle")
        or payload.get("subscriptionType")
        or "Free"
    ).strip()

    next_reset = payload.get("nextDateReset") or payload.get("nextResetDate") or ""

    return {
        "totalCredits": total,
        "remainingCredits": remaining,
        "usedCredits": used,
        "packageName": sub_title,
        "expiresAt": next_reset,
    }


# ---------------------------------------------------------------------------
# Main login flow
# ---------------------------------------------------------------------------


async def run_login(email: str, password: str):
    """Run the full Kiro OAuth PKCE login flow."""
    browser = None
    manager = None

    try:
        from browserforge.fingerprints import Screen
        from camoufox.async_api import AsyncCamoufox
    except ImportError as exc:
        result_failure(f"Missing dependency: {exc}. Run: pip install camoufox browserforge")
        return

    try:
        # Step 1: Generate PKCE pair
        code_verifier, code_challenge = generate_pkce_pair()
        debug(f"PKCE: verifier={code_verifier[:20]}... challenge={code_challenge[:20]}...")

        # Step 2: Build auth URL
        state = str(uuid.uuid4())
        auth_url = f"{KIRO_LOGIN_ENDPOINT}?" + urlencode({
            "idp": "Google",
            "redirect_uri": KIRO_REDIRECT_URI,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "state": state,
            "prompt": "select_account",
        })

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

        # Step 4: Intercept kiro:// redirect to capture auth code
        auth_code = None

        def on_response(response):
            nonlocal auth_code
            if auth_code:
                return
            try:
                location = response.headers.get("location", "")
                code = extract_code_from_kiro_url(location)
                if code:
                    auth_code = code
                    debug(f"Auth code captured from response redirect: {code[:20]}...")
            except Exception:
                pass

        # Listen for response redirects (captures kiro:// from Location header)
        page.on("response", on_response)

        # Step 5: Navigate to Kiro auth (BEFORE setting up route handler)
        progress("navigate", f"Navigating to Kiro auth page...")
        debug(f"Auth URL: {auth_url[:100]}...")
        try:
            await page.goto(auth_url, wait_until="domcontentloaded", timeout=30000)
        except Exception as nav_exc:
            # Retry once — proxy may need warm-up
            debug(f"First navigation failed: {nav_exc}, retrying...")
            progress("navigate_retry", "Navigation failed, retrying...")
            await asyncio.sleep(2.0)
            try:
                await page.goto(auth_url, wait_until="domcontentloaded", timeout=30000)
            except Exception as nav_exc2:
                result_failure(f"Navigation failed: {nav_exc2}")
                return
        await asyncio.sleep(2.0)

        # Also intercept navigation requests to kiro:// scheme
        # (browser tries to navigate there after OAuth completes)
        async def route_handler(route):
            nonlocal auth_code
            if auth_code:
                try:
                    await route.continue_()
                except Exception:
                    pass
                return
            request_url = route.request.url
            code = extract_code_from_kiro_url(request_url)
            if code:
                auth_code = code
                debug(f"Auth code captured from route: {code[:20]}...")
                try:
                    await route.abort()
                except Exception:
                    pass
                return
            try:
                await route.continue_()
            except Exception:
                pass

        await page.route("**/*", route_handler)

        # Step 6: Auth loop — automate Google login
        progress("auth_loop", "Automating Google login...")
        page.set_default_timeout(5000)

        email_transition_deadline = 0.0
        password_transition_deadline = 0.0
        email_step_started_at = None

        for iteration in range(AUTH_LOOP_MAX_ITERATIONS):
            # Check if auth code already captured
            if auth_code:
                progress("auth_complete", "Authentication successful (code captured)!")
                break

            # Also check current URL for kiro:// redirect
            try:
                current_url = page.url
            except Exception:
                current_url = ""

            code_from_url = extract_code_from_kiro_url(current_url)
            if code_from_url:
                auth_code = code_from_url
                progress("auth_complete", "Authentication successful (redirect captured)!")
                break

            parsed_url = urlparse(current_url) if current_url else None
            current_host = parsed_url.netloc if parsed_url else ""
            current_path = parsed_url.path if parsed_url else ""
            on_google = "accounts.google.com" in current_host
            now = time.monotonic()

            # Debug URL changes
            if iteration % 10 == 0:
                debug(f"Iteration {iteration}: url={current_url[:100]}")

            # Skip SetSID redirects
            if "SetSID" in current_url or "/accounts/set" in current_url.lower():
                await asyncio.sleep(0.5)
                continue

            # Google auth steps — check email/password FIRST before other handlers
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

            # Handle Google G+ ToS (only after email/password check)
            if on_google and await _handle_google_gaplustos(page):
                await asyncio.sleep(0.8)
                continue

            # Handle Google consent (only after email/password check)
            if on_google and await _handle_google_consent(page):
                await asyncio.sleep(0.8)
                continue

            # Detect blocking
            if on_google:
                blocking = await _detect_blocking(page)
                if blocking:
                    is_headless = os.getenv("HEXOS_HEADLESS", "true").lower() == "true"
                    if blocking.startswith("hard:"):
                        result_failure(f"Google blocked: {blocking[5:]}. Try with --no-headless")
                        return
                    elif blocking.startswith("soft:"):
                        if not is_headless:
                            progress("challenge", f"Challenge detected: {blocking[5:]} — solve in browser (120s)...")
                            # Wait for challenge to be resolved
                            for _ in range(240):
                                await asyncio.sleep(0.5)
                                if auth_code:
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
            result_failure("Auth loop timeout: did not capture authorization code")
            return

        if not auth_code:
            result_failure("No authorization code captured")
            return

        # Step 7: Exchange code for tokens
        progress("token_exchange", "Exchanging code for tokens...")
        token_result = await exchange_code_for_tokens(auth_code, code_verifier)

        if "error" in token_result:
            result_failure(token_result["error"])
            return

        access_token = token_result["access_token"]
        refresh_token = token_result.get("refresh_token", "")
        profile_arn = token_result.get("profile_arn", "")

        if not access_token:
            result_failure("Token exchange returned empty accessToken")
            return

        progress("tokens_ok", f"Tokens obtained (profileArn: {profile_arn[:40]}...)" if profile_arn else "Tokens obtained")

        # Step 8: Fetch usage/quota
        progress("fetch_usage", "Fetching account usage...")
        credit = await fetch_kiro_usage(access_token, profile_arn)
        if credit:
            remaining = credit.get("remainingCredits", 0)
            total = credit.get("totalCredits", 0)
            pkg = credit.get("packageName", "Unknown")
            progress("usage_info", f"Usage: {remaining:.0f}/{total:.0f} requests — {pkg}")
        else:
            progress("usage_info", "Could not fetch usage info")

        # Step 9: Return result
        result_success(access_token, refresh_token, profile_arn, credit)

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
    parser = argparse.ArgumentParser(description="Hexos Kiro browser login")
    parser.add_argument("--email", required=True, help="Google email")
    parser.add_argument("--password", required=True, help="Google password")
    args = parser.parse_args()

    await run_login(args.email, args.password)


if __name__ == "__main__":
    asyncio.run(main())
