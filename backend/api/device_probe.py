"""
Connection checks of biometric devices, run from the server.

What a check can tell depends on WHERE the server is. A server on the factory network can reach a device directly,
so a check reads everything: whether it answers a ping, whether its communication port is open, whether the
password is right, and the device's own settings (IP, gateway, DNS, which server it pushes to, on which port). A
server in the cloud (Railway) cannot reach a private 192.168.x.x address at all, so every check from it fails with a
timeout, and that is the right answer: it says "unreachable from here", not "the device is broken". The Biometric
Device Status page puts both kinds of evidence side by side (what the server RECEIVES from the device, and what it
can REACH), and device_diagnosis.py turns them into a verdict.

Nothing here ever changes a device. It does not disable it (the way a sync does, which pauses the terminal for a
while), does not write to it and does not read any attendance data: it connects, reads a few settings and
disconnects. Every step is bounded in time, so a dead device cannot hang a request.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import re
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FutureTimeout
from datetime import datetime

logger = logging.getLogger(__name__)

PING_TIMEOUT_SECONDS = 3
TCP_TIMEOUT_SECONDS = 3.0
ZK_TIMEOUT_SECONDS = 6
SETTINGS_READ_BUDGET_SECONDS = 4.0
# One request must finish well inside Railway's 30 s limit, however many devices are checked.
CHECK_BUDGET_SECONDS = 24
MAX_WORKERS = 8

# Outcomes of a check, worst information first in the diagnosis: see device_diagnosis.py
REACHABLE = "reachable"
TIMEOUT = "timeout"
REFUSED = "refused"
UNREACHABLE = "unreachable"
DNS_FAILED = "dns"
AUTH_FAILED = "auth"
ERROR = "error"

# What is read from the device (ZK option names). The names are the device's own; the values are plain strings.
OPTION_KEYS = {
    "serial": "~SerialNumber",
    "deviceName": "~DeviceName",
    "platform": "~Platform",
    "mac": "MAC",
    "ip": "IPAddress",
    "mask": "NetMask",
    "gateway": "GATEIPAddress",
    "dns": "DNS",
    "dhcp": "DHCP",
    "serverUrl": "ICLOCKSVRURL",
    "serverPort": "WebServerPort",
    "admsEnabled": "IclockSvrFun",
    "proxyEnabled": "EnableProxyServer",
    "timeZoneMinutes": "TZAdj",
}

_HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")
_PING_TIME_RE = re.compile(r"time\s*[=<]\s*([\d.]+)\s*ms", re.IGNORECASE)

_run_lock = threading.Lock()


class CheckBusy(Exception):
    """A check is already running on this server."""


def valid_host(host: str) -> bool:
    """An IP address or a plain host name: nothing that could be read as an option by the ping command."""
    return bool(host) and bool(_HOST_RE.match(host)) and not host.startswith("-")


def is_private_host(host: str) -> bool:
    """True for an address that only exists inside a private network (192.168.x.x, 10.x.x.x, 172.16-31.x.x...)."""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local


def _step(key: str, label: str, ok: bool | None, ms: float | None = None, note: str = "") -> dict:
    return {"key": key, "label": label, "ok": ok, "ms": None if ms is None else round(ms, 1), "note": note}


def icmp_ping(host: str, timeout: int = PING_TIMEOUT_SECONDS) -> dict:
    """One ICMP echo through the operating system's ping. {"available", "ok", "ms"}.

    Not every server can do this (a slim Linux container often has no ping program, and some hosts forbid it), so
    "available": False is a normal answer, not an error: the TCP step below is the one that always works."""
    windows = os.name == "nt"
    command = (
        ["ping", "-n", "1", "-w", str(timeout * 1000), host]
        if windows
        else ["ping", "-c", "1", "-W", str(timeout), host]
    )
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=timeout + 2, check=False)
    except FileNotFoundError:
        return {"available": False, "ok": False, "ms": None}
    except subprocess.TimeoutExpired:
        return {"available": True, "ok": False, "ms": None}
    except OSError:
        return {"available": False, "ok": False, "ms": None}
    out = done.stdout or ""
    # Windows' ping exits 0 even for "Destination host unreachable" (a reply FROM A ROUTER, not from the target), so
    # the exit code alone proves nothing: a real echo reply carries a TTL (Windows) or "bytes from" (Linux/macOS).
    replied = done.returncode == 0 and ("ttl=" in out.lower() or "bytes from" in out.lower())
    if not replied:
        return {"available": True, "ok": False, "ms": None}
    found = _PING_TIME_RE.search(out)
    # "time<1ms" has no number to read as an exact time; a localised ping may not print "time=" at all
    ms = float(found.group(1)) if found else None
    if ms is None and "<" in out and "ms" in out.lower():
        ms = 1.0
    return {"available": True, "ok": True, "ms": ms}


def tcp_connect(host: str, port: int, timeout: float = TCP_TIMEOUT_SECONDS) -> tuple[float | None, str | None, str]:
    """Open and close a TCP connection. Returns (milliseconds, failure kind or None, message).
    The kind is one of TIMEOUT, REFUSED, UNREACHABLE, ERROR."""
    started = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            pass
    except (socket.timeout, TimeoutError):
        return None, TIMEOUT, f"No answer within {timeout:g} seconds"
    except ConnectionRefusedError:
        return None, REFUSED, "The address answered but refused the connection"
    except OSError as exc:
        code = getattr(exc, "winerror", None) or exc.errno
        # ENETUNREACH 101, EHOSTUNREACH 113 (Linux), WSAENETUNREACH 10051, WSAEHOSTUNREACH 10065 (Windows)
        if code in (101, 113, 10051, 10065):
            return None, UNREACHABLE, "No route to that address from this server"
        return None, ERROR, str(exc)
    return (time.perf_counter() - started) * 1000, None, ""


class ProbeFailure(Exception):
    """The device was reached but would not talk: a wrong password or a protocol failure."""

    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _read_option(conn, key: str) -> str | None:
    """One setting from a connected device, or None when the device does not have it. pyzk exposes only a few
    settings by name (network_params), so the rest go through the same read-option command it uses itself."""
    from zk import const

    response = conn._ZK__send_command(const.CMD_OPTIONS_RRQ, key.encode() + b"\x00", 1024)
    if not response.get("status"):
        return None
    value = conn._ZK__data.split(b"=", 1)[-1].split(b"\x00")[0].decode(errors="replace").strip()
    return value


def _as_int(value: str | None) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def read_device(host: str, port: int, password: int, now_ist: datetime, timeout: int = ZK_TIMEOUT_SECONDS) -> dict:
    """Connect to the device, read who it is and how it is set up, and disconnect. Raises ProbeFailure on a wrong
    password or any protocol failure. Never disables the device."""
    from zk import ZK
    from zk.exception import ZKErrorConnection, ZKErrorResponse, ZKNetworkError

    conn = None
    try:
        conn = ZK(host, port=port, timeout=timeout, password=password, force_udp=False, ommit_ping=True).connect()
    except ZKErrorResponse as exc:
        if "unauth" in str(exc).lower():
            raise ProbeFailure(AUTH_FAILED, "The device refused the communication password (Comm Key).") from exc
        raise ProbeFailure(ERROR, f"The device answered, but not in the expected way: {exc}") from exc
    except (ZKNetworkError, ZKErrorConnection, OSError) as exc:
        raise ProbeFailure(ERROR, f"The device did not complete the handshake: {exc}") from exc

    try:
        detail: dict = {}
        deadline = time.monotonic() + SETTINGS_READ_BUDGET_SECONDS
        for name, key in OPTION_KEYS.items():
            if time.monotonic() > deadline:
                break
            try:
                value = _read_option(conn, key)
            except Exception:  # noqa: BLE001 -one setting this model does not have must not lose the rest
                value = None
            if value:
                detail[name] = value
        # tidy the types the page and the diagnosis compare on
        for flag in ("dhcp", "admsEnabled", "proxyEnabled"):
            if flag in detail:
                detail[flag] = detail[flag] not in ("0", "", "false", "False")
        if "serverPort" in detail:
            detail["serverPort"] = _as_int(detail["serverPort"])
        if "timeZoneMinutes" in detail:
            detail["timeZoneMinutes"] = _as_int(detail["timeZoneMinutes"])
        try:
            device_time = conn.get_time()
            detail["deviceTime"] = device_time.replace(microsecond=0).isoformat()
            detail["clockSkewSeconds"] = int((device_time - now_ist).total_seconds())
        except Exception:  # noqa: BLE001
            pass
        try:
            conn.read_sizes()
            detail["users"], detail["records"] = int(conn.users), int(conn.records)
        except Exception:  # noqa: BLE001
            pass
        return detail
    finally:
        try:
            conn.disconnect()
        except Exception:  # noqa: BLE001
            pass


def probe_device(host: str, port: int | None, password: int, now_ist: datetime) -> dict:
    """Check one device. Returns {"status", "latencyMs", "icmp", "error", "detail", "steps"}.

    status: reachable (the device answered and told us about itself), timeout, refused, unreachable (no route),
    dns (the host name does not resolve), auth (wrong Comm Key), error (anything else, with the reason in "error")."""
    port = port or 4370
    steps: list[dict] = []
    result: dict = {"status": ERROR, "latencyMs": None, "icmp": None, "error": "", "detail": None, "steps": steps}

    if not valid_host(host):
        steps.append(_step("address", "Device address", False, note="Not a valid IP address or host name"))
        result["error"] = f"'{host}' is not a valid IP address or host name. Edit the device in Settings → Devices."
        return result

    # 1. the address: a name has to resolve to an IP first
    ip = host
    try:
        ipaddress.ip_address(host)
        steps.append(_step("address", "Device address", True, note=host))
    except ValueError:
        started = time.perf_counter()
        try:
            ip = socket.getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_STREAM)[0][4][0]
            steps.append(_step("address", "Look up the host name", True, (time.perf_counter() - started) * 1000, ip))
        except socket.gaierror as exc:
            steps.append(
                _step("address", "Look up the host name", False, (time.perf_counter() - started) * 1000, str(exc))
            )
            result.update(status=DNS_FAILED, error=f"The host name '{host}' could not be found (DNS).")
            return result

    # 2. ping: a reply proves the machine is on the network even if the service port is closed
    ping = icmp_ping(ip)
    result["icmp"] = ping
    if not ping["available"]:
        steps.append(
            _step(
                "ping", "Ping (ICMP)", None, note="Not available on this server; the port check below is used instead"
            )
        )
    elif ping["ok"]:
        steps.append(_step("ping", "Ping (ICMP)", True, ping["ms"], "Replied"))
    else:
        steps.append(_step("ping", "Ping (ICMP)", False, note="No reply"))

    # 3. the device's communication port
    ms, kind, message = tcp_connect(ip, port)
    if kind:
        steps.append(_step("port", f"Open port {port}", False, note=message))
        result.update(status=kind, error=message)
        return result
    result["latencyMs"] = round(ms, 1)
    steps.append(_step("port", f"Open port {port}", True, ms, "Connected"))

    # 4. the device itself: password, identity and settings
    started = time.perf_counter()
    try:
        detail = read_device(ip, port, password, now_ist)
    except ProbeFailure as exc:
        steps.append(_step("device", "Talk to the device", False, (time.perf_counter() - started) * 1000, exc.message))
        result.update(status=exc.status, error=exc.message)
        return result
    except Exception as exc:  # noqa: BLE001 -a check must report, never raise
        logger.exception("Unexpected failure checking device %s", host)
        steps.append(_step("device", "Talk to the device", False, note=str(exc)))
        result.update(status=ERROR, error=str(exc))
        return result
    steps.append(_step("device", "Talk to the device", True, (time.perf_counter() - started) * 1000, "Answered"))
    steps.append(
        _step(
            "settings",
            "Read its settings",
            bool(detail),
            note=f"{len(detail)} read" if detail else "None could be read",
        )
    )
    result.update(status=REACHABLE, detail=detail)
    return result


def run_checks(targets: list[dict], now_ist: datetime) -> dict[int, dict]:
    """Check several devices at once. Each target: {"id", "host", "port", "password"}. Returns {id: result}.

    One check at a time per server (CheckBusy otherwise): a second click while the first is still running must not
    start another round of connections to the same devices."""
    if not _run_lock.acquire(blocking=False):
        raise CheckBusy()
    pool = ThreadPoolExecutor(max_workers=max(1, min(MAX_WORKERS, len(targets))))
    results: dict[int, dict] = {}
    try:
        futures = {
            pool.submit(probe_device, t["host"], t.get("port"), t.get("password", 0), now_ist): t for t in targets
        }
        try:
            for future in as_completed(futures, timeout=CHECK_BUDGET_SECONDS):
                target = futures[future]
                try:
                    results[target["id"]] = future.result()
                except Exception as exc:  # noqa: BLE001
                    results[target["id"]] = _failed(f"The check failed unexpectedly: {exc}")
        except FutureTimeout:
            pass
        for target in targets:
            results.setdefault(
                target["id"],
                _failed(f"The check did not finish within {CHECK_BUDGET_SECONDS} seconds.", status=TIMEOUT),
            )
        return results
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        _run_lock.release()


def _failed(message: str, status: str = ERROR) -> dict:
    return {"status": status, "latencyMs": None, "icmp": None, "error": message, "detail": None, "steps": []}
