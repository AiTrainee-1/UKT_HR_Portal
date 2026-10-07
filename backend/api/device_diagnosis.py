"""
Why is (or isn't) this biometric device connected? Turns the evidence the server has into a verdict, layer by layer.

Pure functions over plain dicts: no database, no network. device_status.py gathers the evidence, device_probe.py
produces the connection-check part of it, and the tests feed this module hand-made evidence for every situation.

The layers are the ones a person debugging this walks through, in the order they are shown:

    device       the machine itself: powered, on the network, answering
    lan          the factory network between it and this server
    firewall     the company firewall on the way out to the internet
    port         the port the device pushes to / the port its communication service listens on
    api          the server's attendance listener accepting what the device sends
    railway      the deployment the devices are supposed to reach
    ip_config    the device's own IP, gateway and DNS settings
    timeout      timeouts and slowness
    auth         the communication password, the serial number, the server address set on the device

Each layer ends in a state: ok (checked and fine), problem (this is wrong), warn (works, but look at it), unknown
(no evidence either way: say what to check) or na (cannot be judged from this server, and why).

Evidence keys (all optional): state, host, port, configuredSerial, lastContactAgeSeconds, remoteIp, lastError,
syncError, probe {status, latencyMs, icmp, error, detail, ageSeconds}, reported {...}, serverOnCloud, serverHost,
serverScheme, privateAddress, lanAnyReachable, pushDelaySeconds.
"""

from __future__ import annotations

from .device_probe import is_private_host

SLOW_CONNECT_MS = 250
SLOW_PUSH_SECONDS = 120
CLOCK_SKEW_WARN_SECONDS = 300
INDIA_UTC_OFFSET_MINUTES = 330
SERVER_PORTS = (80, 443)

OK, WARN, PROBLEM, UNKNOWN, NA = "ok", "warn", "problem", "unknown", "na"

LAYERS = (
    ("device", "Biometric device"),
    ("lan", "Local network (LAN)"),
    ("firewall", "Firewall"),
    ("port", "Port configuration"),
    ("api", "API connection"),
    ("railway", "Railway deployment"),
    ("ip_config", "Device IP configuration"),
    ("timeout", "Network timeout"),
    ("auth", "Authentication & configuration"),
)
# Which finding is shown as THE reason, when several layers have a problem: the one that has to be fixed first.
HEADLINE_ORDER = ("ip_config", "port", "auth", "firewall", "api", "timeout", "lan", "device")

ZERO_ADDRESSES = ("", "0.0.0.0")


def _layer(key: str, state: str, finding: str, action: str = "") -> dict:
    label = dict(LAYERS)[key]
    return {"key": key, "label": label, "state": state, "finding": finding, "action": action}


def _ago(seconds: float | None) -> str:
    if seconds is None:
        return "a while ago"
    if seconds < 90:
        return f"{int(seconds)} seconds ago"
    if seconds < 5400:
        return f"{round(seconds / 60)} minutes ago"
    if seconds < 172800:
        return f"{round(seconds / 3600)} hours ago"
    return f"{round(seconds / 86400)} days ago"


def device_config(ev: dict) -> dict:
    """What is known about the device's own settings: read from it by a connection check when that got through,
    otherwise what it reported about itself when it contacted the server. Empty when neither exists."""
    probe = ev.get("probe") or {}
    read = probe.get("detail") if probe.get("status") == "reachable" else None
    read = read or {}
    reported = ev.get("reported") or {}

    def pick(*pairs):
        for source, key in pairs:
            value = source.get(key)
            if value not in (None, ""):
                return value
        return None

    tz = pick((read, "timeZoneMinutes"), (reported, "TZAdj"))
    try:
        tz = int(tz) if tz is not None else None
    except (TypeError, ValueError):
        tz = None
    return {
        "ip": pick((read, "ip"), (reported, "IPAddress")),
        "gateway": pick((read, "gateway"), (reported, "GATEIPAddress")),
        "dns": pick((read, "dns"), (reported, "DNS")),
        "dhcp": read.get("dhcp"),
        "serverUrl": read.get("serverUrl"),
        "serverPort": read.get("serverPort"),
        "admsEnabled": read.get("admsEnabled"),
        "serial": pick((read, "serial"), (reported, "~SerialNumber")),
        "timeZoneMinutes": tz,
        "clockSkewSeconds": read.get("clockSkewSeconds"),
        "fromDevice": bool(read),
    }


def _is_ip(value: str | None) -> bool:
    parts = (value or "").split(".")
    return len(parts) == 4 and all(p.isdigit() and int(p) < 256 for p in parts)


def _cloud_cannot_see(ev: dict) -> bool:
    """A server in the cloud checking a private (192.168.x.x) address has no route there, so a check that gets no
    answer says nothing about the device. (Once any device has answered, the server clearly can see the factory.)"""
    if not ev.get("serverOnCloud") or ev.get("lanAnyReachable"):
        return False
    private = ev.get("privateAddress")
    if private is None:
        private = is_private_host(ev.get("host") or "")
    return bool(private)


def _device_checklist(server_host: str) -> str:
    """What to look at on a device that has never reached the server, and the firewall it goes through."""
    address = server_host.split(":")[0] or "the server's address"
    return (
        f"On the device, Menu → COMM. → Cloud Server Setting: Server Address {address}, Server Port 443, HTTPS on. "
        "Menu → COMM. → Ethernet: DNS 8.8.8.8 and Gateway = the router. "
        "Then make sure the company firewall lets the device out on HTTPS (port 443) and DNS. "
        "This server is in the cloud and cannot read the device's settings: run the check from the local app on a "
        "factory computer to see them."
    )


def diagnose(ev: dict) -> dict:
    """The verdict for one device: {"headline", "headlineLayer", "action", "layers": [...], "problems": [keys]}."""
    state = ev.get("state") or "never"
    if state == "disabled":
        layers = [
            _layer(key, NA, "Switched off in Settings → Devices, so it is not being monitored.") for key, _ in LAYERS
        ]
        return {
            "headline": "Switched off in Settings → Devices, so it is not being monitored.",
            "headlineLayer": None,
            "action": "Switch it on in Settings → Devices to monitor it again.",
            "layers": layers,
            "problems": [],
        }

    probe = ev.get("probe") or None
    cfg = device_config(ev)
    connected = state == "connected"
    cloud = bool(ev.get("serverOnCloud"))
    server_host = ev.get("serverHost") or ""
    host = ev.get("host") or ""
    probe_status = (probe or {}).get("status")
    heard = ev.get("lastContactAgeSeconds")
    # A device that sends to another server (the deployed one) cannot be seen arriving on this local one: what is
    # missing here says nothing about whether it works there.
    url = (cfg.get("serverUrl") or "").strip().lower()
    bare_server = server_host.split(":")[0].strip().lower()
    elsewhere = (not cloud) and bool(url) and bool(bare_server) and url != bare_server

    layers = {
        "device": _device_layer(ev, probe, probe_status, connected, heard),
        "lan": _lan_layer(ev, probe, probe_status, connected, cloud),
        "firewall": _elsewhere_layer("firewall", url)
        if elsewhere and not connected
        else _firewall_layer(ev, cfg, connected, server_host, host),
        "port": _port_layer(ev, cfg, probe_status, connected),
        "api": _elsewhere_layer("api", url) if elsewhere and not connected else _api_layer(ev, connected, heard),
        "railway": _railway_layer(cloud, server_host),
        "ip_config": _ip_layer(ev, cfg, connected, host),
        "timeout": _timeout_layer(probe, probe_status, ev),
        "auth": _auth_layer(ev, cfg, probe_status, probe, cloud, server_host),
    }
    ordered = [layers[key] for key, _ in LAYERS]
    problems = [layer["key"] for layer in ordered if layer["state"] == PROBLEM]

    headline_layer = next((layers[k] for k in HEADLINE_ORDER if layers[k]["state"] == PROBLEM), None)
    if headline_layer is None and not elsewhere:
        headline_layer = next((layers[k] for k in HEADLINE_ORDER if layers[k]["state"] == WARN), None)
    if headline_layer is None and elsewhere and connected:
        headline_layer = next((layers[k] for k in HEADLINE_ORDER if layers[k]["state"] == WARN), None)
    if connected and not problems:
        warn = headline_layer
        headline = f"Connected: attendance is arriving (last heard {_ago(heard)})."
        action = warn["action"] if warn else ""
        if warn:
            headline += f" Worth a look: {warn['finding']}"
        headline_key = warn["key"] if warn else None
    elif headline_layer is not None:
        headline, action, headline_key = headline_layer["finding"], headline_layer["action"], headline_layer["key"]
    elif elsewhere:
        headline = f"This device sends its attendance to {url}, not to this local server, so this server cannot see whether it arrives."
        action = f"Open this page on {url} (the deployed site) to see whether the device is connected there."
        headline_key = "railway"
    elif state == "never" and cloud:
        headline = "Nothing has ever been received from this device, so it has not reached this server."
        action = _device_checklist(server_host)
        headline_key = None
    elif state == "never":
        headline = "Nothing has been received from this device yet, and no connection check has been run."
        action = "Run a connection check from a computer on the factory network, and confirm the device's Cloud Server (ADMS) settings."
        headline_key = None
    else:
        headline = f"Silent since {_ago(heard)}, with no check run since."
        action = "Check power and network at the device, then run a connection check."
        headline_key = None
    return {
        "headline": headline,
        "headlineLayer": headline_key,
        "action": action,
        "layers": ordered,
        "problems": problems,
    }


# ── the layers ──────────────────────────────────────────────────────────────────────────────────────────────────────


def _device_layer(ev, probe, probe_status, connected, heard) -> dict:
    if connected:
        return _layer("device", OK, f"The device is on and talking to this server (last heard {_ago(heard)}).")
    if probe_status == "reachable":
        return _layer("device", OK, "The device answered a connection check from this server.")
    if probe_status in ("auth", "refused"):
        return _layer("device", OK, "The device is on and answering on the network (see the port and password checks).")
    if probe_status in ("timeout", "unreachable"):
        if ev.get("lanAnyReachable"):
            return _layer(
                "device",
                PROBLEM,
                "No answer from this device, while other devices on the same network answered this server.",
                "Check the device's power and network cable, and its IP address on the device (Menu → COMM. → Ethernet).",
            )
        if ev.get("serverOnCloud"):
            return _layer(
                "device",
                UNKNOWN,
                "This server is in the cloud and cannot see the factory network, so it cannot tell whether the device is on.",
                "Look at the device itself, or run the check from the local app on a computer on the factory network.",
            )
        return _layer(
            "device",
            UNKNOWN,
            "No answer, and no other device answered either, so the device may be fine.",
            "Check this server's own network connection first, then the device.",
        )
    if ev.get("state") == "disconnected":
        return _layer(
            "device",
            WARN,
            f"It was connected before but nothing has arrived since {_ago(heard)}.",
            "Check that the device is powered on, its screen shows a network connection, and its Cloud Server setting is still on.",
        )
    return _layer(
        "device",
        UNKNOWN,
        "No sign of this device yet, and no connection check has been run.",
        "Run a connection check from a computer on the factory network.",
    )


def _lan_layer(ev, probe, probe_status, connected, cloud) -> dict:
    if connected or probe_status in ("reachable", "auth", "refused"):
        return _layer("lan", OK, "The device is reachable on the network.")
    if probe_status in ("timeout", "unreachable", "dns"):
        if ev.get("lanAnyReachable"):
            return _layer(
                "lan",
                PROBLEM,
                "Other devices answer from this server but this one does not: the problem is between this device and the network.",
                "Check its network cable, the switch port and its IP address and subnet mask.",
            )
        if cloud:
            return _layer(
                "lan",
                NA,
                "This server runs in the cloud, so the factory network cannot be tested from it. This is expected for a device on a 192.168.x.x address.",
                "Run the check from the local app on a computer on the factory network to test the LAN itself.",
            )
        return _layer(
            "lan",
            PROBLEM,
            "Nothing on the network answered this server.",
            "Check this server's network connection, then the switch and cabling at the factory.",
        )
    return _layer("lan", UNKNOWN, "Not tested yet.", "Run a connection check.")


def _firewall_layer(ev, cfg, connected, server_host, host) -> dict:
    where = server_host or "the server"
    if connected:
        ip = ev.get("remoteIp")
        return _layer(
            "firewall",
            OK,
            f"The device's traffic gets through to this server{f' (it arrives from {ip})' if ip else ''}.",
        )
    blockers = _config_blockers(cfg)
    if blockers:
        return _layer(
            "firewall",
            WARN,
            "The firewall cannot be judged yet: the device's own settings would stop it reaching the server anyway.",
            "Fix the device settings flagged above first, then see whether data arrives.",
        )
    if cfg.get("fromDevice"):
        return _layer(
            "firewall",
            PROBLEM,
            "The device is set up correctly, yet nothing reaches this server: the company firewall is the likely cause.",
            f"Allow outbound HTTPS (port 443) and DNS from the device ({host}) to {where}.",
        )
    return _layer(
        "firewall",
        UNKNOWN,
        "Cannot be confirmed from here.",
        f"Make sure the firewall allows outbound HTTPS (port 443) and DNS from the device ({host}) to {where}.",
    )


def _port_layer(ev, cfg, probe_status, connected) -> dict:
    if connected:
        return _layer("port", OK, "The device is pushing on a port the server accepts.")
    port = cfg.get("serverPort")
    https = ev.get("serverScheme") == "https"
    if port is not None and port not in SERVER_PORTS:
        if https:
            return _layer(
                "port",
                PROBLEM,
                f"The device is set to send to port {port}, but this server answers on port 443 (HTTPS) only; nothing answers on {port}.",
                "On the device: Menu → COMM. → Cloud Server Setting → set the server port to 443 and turn HTTPS on, the same as a device that works.",
            )
        return _layer(
            "port",
            PROBLEM,
            f"The device is set to send to port {port}, but the server only accepts connections on 443 (HTTPS) or 80.",
            "On the device: Menu → COMM. → Cloud Server Setting → set the server port to 443 with HTTPS on (or 80 with HTTPS off), the same as a device that works.",
        )
    if https and port == 80:
        return _layer(
            "port",
            WARN,
            "The device sends plain HTTP on port 80, but this server is served over HTTPS and normally redirects port 80 to HTTPS, which a device cannot follow.",
            "On the device: Menu → COMM. → Cloud Server Setting → set the server port to 443 and turn HTTPS on, the same as a device that works.",
        )
    if probe_status == "refused":
        return _layer(
            "port",
            PROBLEM,
            f"The device's communication port ({ev.get('port') or 4370}) is closed: the machine answered but refused the connection.",
            "Check that TCP COMM. Port on the device (Menu → COMM. → Ethernet) matches the port in Settings → Devices.",
        )
    if probe_status == "reachable" or port in SERVER_PORTS:
        return _layer("port", OK, "The communication port is open and the server port is a standard one.")
    return _layer(
        "port",
        UNKNOWN,
        "No port information yet.",
        "Run a check from the factory network to read the device's server port.",
    )


def _api_layer(ev, connected, heard) -> dict:
    last_error = ev.get("lastError")
    if connected and not last_error:
        return _layer("api", OK, "The server accepts what the device sends.")
    if last_error:
        return _layer(
            "api",
            PROBLEM if not connected else WARN,
            last_error,
            "Check the device's firmware and its Cloud Server settings; if it keeps happening, the format of its attendance lines needs a look.",
        )
    if ev.get("state") == "disconnected":
        return _layer(
            "api",
            WARN,
            f"The server accepted this device's requests until {_ago(heard)}.",
            "Check the device is powered on and shows a network connection, that its Cloud Server settings have not "
            "changed, and that the firewall still lets it out on HTTPS (port 443) and DNS.",
        )
    return _layer("api", UNKNOWN, "No request from this device has reached the server yet.", "")


def _elsewhere_layer(key: str, url: str) -> dict:
    return _layer(
        key,
        NA,
        f"Cannot be judged here: this device sends to {url}, not to this local server.",
        f"Open this page on {url} (the deployed site) to judge it.",
    )


def _railway_layer(cloud: bool, server_host: str) -> dict:
    if cloud:
        return _layer(
            "railway",
            OK,
            f"This server (Railway) is up and answering. Devices should send to {server_host or 'its address'}.",
        )
    return _layer(
        "railway",
        NA,
        "This is a local server, not the Railway deployment, so the deployment cannot be judged from here.",
        "Open this page on the deployed site to see what Railway is receiving.",
    )


def _config_blockers(cfg: dict) -> list[str]:
    """Settings that on their own stop a device from pushing."""
    found = []
    if cfg.get("gateway") is not None and cfg["gateway"] in ZERO_ADDRESSES:
        found.append("gateway")
    if (
        cfg.get("dns") is not None
        and cfg["dns"] in ZERO_ADDRESSES
        and cfg.get("serverUrl")
        and not _is_ip(cfg["serverUrl"])
    ):
        found.append("dns")
    if cfg.get("serverPort") is not None and cfg["serverPort"] not in SERVER_PORTS:
        found.append("port")
    if cfg.get("admsEnabled") is False:
        found.append("adms")
    return found


def _ip_layer(ev, cfg, connected, host) -> dict:
    gateway, dns, ip = cfg.get("gateway"), cfg.get("dns"), cfg.get("ip")
    if gateway is not None and gateway in ZERO_ADDRESSES:
        return _layer(
            "ip_config",
            PROBLEM,
            "The device has no gateway (0.0.0.0), so it cannot reach anything outside the factory network, including this server.",
            "On the device: Menu → COMM. → Ethernet → Gateway = your router's address (for example 192.168.0.254).",
        )
    if dns is not None and dns in ZERO_ADDRESSES and cfg.get("serverUrl") and not _is_ip(cfg["serverUrl"]):
        return _layer(
            "ip_config",
            PROBLEM,
            f"The device has no DNS server (0.0.0.0), so it cannot look up {cfg['serverUrl']} and never finds the server.",
            "On the device: Menu → COMM. → Ethernet → DNS = 8.8.8.8 (or your router's address), the same as a device that works.",
        )
    if ip and _is_ip(host) and ip != host:
        return _layer(
            "ip_config",
            PROBLEM,
            f"The device reports its address as {ip}, but Settings → Devices has {host}.",
            "Correct the host in Settings → Devices (or the IP on the device); if the device uses DHCP, give it a fixed address.",
        )
    if cfg.get("dhcp") is True:
        return _layer(
            "ip_config",
            WARN,
            "The device takes its address by DHCP, so its IP can change and the address in Settings would go stale.",
            "Give the device a fixed IP on the device (Menu → COMM. → Ethernet → DHCP off).",
        )
    if connected or cfg.get("fromDevice"):
        return _layer("ip_config", OK, "The device's IP, gateway and DNS settings look right.")
    return _layer(
        "ip_config",
        UNKNOWN,
        "The device's network settings have not been read.",
        "Run a check from the factory network to read them.",
    )


def _timeout_layer(probe, probe_status, ev) -> dict:
    if probe_status in ("timeout", "unreachable") and _cloud_cannot_see(ev):
        return _layer(
            "timeout",
            NA,
            "This server runs in the cloud and cannot reach a 192.168.x.x address, so a check with no answer says nothing about this device.",
            "Timing shows here once the device connects: the page measures how long its punches take to arrive.",
        )
    if probe_status == "timeout":
        return _layer(
            "timeout",
            PROBLEM,
            f"The connection check timed out: {probe.get('error') or 'no answer'}.",
            "Check the device is on and on the network; a timeout means packets are being lost or dropped on the way.",
        )
    latency = (probe or {}).get("latencyMs")
    if latency is not None and latency > SLOW_CONNECT_MS:
        return _layer(
            "timeout",
            WARN,
            f"Slow connection: the device took {latency:.0f} ms to accept a connection.",
            "A busy switch, a weak link or a long cable run can cause this; check the cable and the switch port.",
        )
    delay = ev.get("pushDelaySeconds")
    if delay is not None and delay > SLOW_PUSH_SECONDS:
        minutes = round(delay / 60)
        return _layer(
            "timeout",
            WARN,
            f"Punches reach the server about {minutes} minutes after they happen, so the device is sending in batches or over a slow link.",
            "Check the device's push interval setting and its network link.",
        )
    if latency is not None:
        return _layer("timeout", OK, f"The device accepts connections quickly ({latency:.0f} ms).")
    if delay is not None:
        return _layer("timeout", OK, "Punches arrive within moments of happening.")
    return _layer("timeout", UNKNOWN, "No timing measured yet.", "Run a check from the factory network to measure it.")


def _auth_layer(ev, cfg, probe_status, probe, cloud, server_host) -> dict:
    if probe_status == "auth":
        return _layer(
            "auth",
            PROBLEM,
            "The device refused the communication password (Comm Key).",
            "Enter the device's Comm Key in Settings → Devices (Menu → COMM. → PC Connection → Password on the device).",
        )
    expected = (ev.get("configuredSerial") or "").strip()
    serial = (cfg.get("serial") or "").strip()
    if expected and serial and expected != serial:
        return _layer(
            "auth",
            PROBLEM,
            f"The device at this address is {serial}, but Settings → Devices expects {expected}: another machine, or a wrong serial.",
            "Check the IP address, or correct the serial number in Settings → Devices.",
        )
    if cfg.get("admsEnabled") is False:
        return _layer(
            "auth",
            PROBLEM,
            "Cloud server push (ADMS) is switched off on the device, so it never sends attendance.",
            "On the device: Menu → COMM. → Cloud Server Setting → Server Mode = ADMS.",
        )
    url = cfg.get("serverUrl")
    if cfg.get("fromDevice") and not url:
        return _layer(
            "auth",
            PROBLEM,
            "No server address is set on the device.",
            f"On the device: Menu → COMM. → Cloud Server Setting → Server Address = {server_host or 'your server'}.",
        )
    if cloud and url and server_host and url.strip().lower() != server_host.strip().lower().split(":")[0]:
        return _layer(
            "auth",
            PROBLEM,
            f"The device sends to '{url}', but this server is '{server_host}'.",
            f"Set the Server Address on the device to {server_host}.",
        )
    tz = cfg.get("timeZoneMinutes")
    if tz is not None and tz != INDIA_UTC_OFFSET_MINUTES:
        return _layer(
            "auth",
            WARN,
            f"The device's time zone is UTC{tz / 60:+g}, not India (UTC+5.5), so its punch times may be wrong.",
            "Set the time zone on the device (Menu → System → Date/Time).",
        )
    skew = cfg.get("clockSkewSeconds")
    if skew is not None and abs(skew) > CLOCK_SKEW_WARN_SECONDS:
        return _layer(
            "auth",
            WARN,
            f"The device's clock is {abs(skew) // 60} minutes {'ahead of' if skew > 0 else 'behind'} the server, so punch times will be off by that much.",
            "Correct the date and time on the device (Menu → System → Date/Time).",
        )
    if cfg.get("fromDevice"):
        return _layer("auth", OK, "Password accepted; the serial number and time settings are right.")
    if ev.get("state") == "connected":
        return _layer("auth", OK, "The server accepts this device.")
    return _layer(
        "auth",
        UNKNOWN,
        "The device's server address, password and serial have not been verified.",
        "Run a check from the factory network to verify them.",
    )
