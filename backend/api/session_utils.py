"""
Login session helpers -device-label parsing for the Login Devices page.

Deliberately a lightweight regex matcher, not a full UA-parsing library:
this only needs to produce a friendly "Chrome on Windows" style label for
display, not perfectly accurate browser/OS detection.
"""
import re


def parse_user_agent(user_agent: str) -> str:
    if not user_agent:
        return "Unknown device"

    ua = user_agent

    if "Edg/" in ua:
        browser = "Edge"
    elif "OPR/" in ua or "Opera" in ua:
        browser = "Opera"
    elif "Firefox/" in ua:
        browser = "Firefox"
    elif "CriOS" in ua:
        browser = "Chrome"
    elif "Chrome/" in ua:
        browser = "Chrome"
    elif "Safari/" in ua and "Version/" in ua:
        browser = "Safari"
    else:
        browser = "Browser"

    if "Windows" in ua:
        os_name = "Windows"
    elif "Mac OS X" in ua and "iPhone" not in ua and "iPad" not in ua:
        os_name = "macOS"
    elif "iPhone" in ua:
        os_name = "iPhone"
    elif "iPad" in ua:
        os_name = "iPad"
    elif "Android" in ua:
        match = re.search(r"Android\s+(\d+)", ua)
        os_name = f"Android {match.group(1)}" if match else "Android"
    elif "Linux" in ua:
        os_name = "Linux"
    else:
        os_name = "Unknown OS"

    return f"{browser} on {os_name}"
