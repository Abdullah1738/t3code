#!/usr/bin/python3
"""Read-only Mirage client detector. Exit 0: clear, 10: client, 20: unknown."""
import argparse
import csv
from dataclasses import dataclass
import ipaddress
import json
import re
import subprocess


class DetectionError(ValueError):
    pass


def tcp_state(value):
    # lsof uses SYN_SENT; nettop uses SynSent (and similarly for the closing states).
    state = value.upper().replace("_", "").replace("-", "")
    if state not in {"CLOSED", "IDLE", "BOUND", "LISTEN", "SYNSENT", "SYNRCD", "SYNRCVD",
                     "SYNRECEIVED", "ESTABLISHED", "CLOSEWAIT", "FINWAIT1", "FINWAIT2",
                     "CLOSING", "LASTACK", "TIMEWAIT"}:
        raise DetectionError("unrecognized TCP state: " + value)
    return state


@dataclass(frozen=True, order=True)
class Flow:
    protocol: str
    local_ip: str
    local_port: int
    peer_ip: str
    peer_port: int

    @property
    def peer(self):
        host = "[{}]".format(self.peer_ip) if ":" in self.peer_ip else self.peer_ip
        return "{}:{}".format(host, self.peer_port)


def endpoint(value):
    value = value.strip()
    if value.startswith("["):
        match = re.fullmatch(r"\[(.+)\][:.](\d+|\*)", value)
        if not match:
            raise DetectionError("invalid endpoint: " + value)
        host, port = match.groups()
    else:
        # nettop uses a dot before the port for IPv6, lsof uses a colon.
        separator = "." if value.rfind(".") > value.rfind(":") else ":"
        host, sep, port = value.rpartition(separator)
        if not sep:
            raise DetectionError("missing port: " + value)
    if host == "*" or port == "*":
        return None
    try:
        ip = ipaddress.ip_address(host.split("%", 1)[0])
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        number = int(port)
        if not 0 < number <= 65535:
            raise ValueError("port out of range")
    except ValueError as exc:
        raise DetectionError("invalid endpoint: " + value) from exc
    zone = "%" + host.split("%", 1)[1] if "%" in host else ""
    return str(ip) + zone, number


def flow(protocol, local, peer):
    own = endpoint(local)
    remote = endpoint(peer)
    if remote is None or ipaddress.ip_address(remote[0].split("%", 1)[0]).is_loopback:
        return None
    if own is None:
        raise DetectionError("connected flow has no local endpoint")
    return Flow(protocol, own[0], own[1], remote[0], remote[1])


def parse_lsof(sample, pid):
    """lsof -FpcfPnT: descriptor duplicates collapse to one transport 5-tuple."""
    flows = set()
    owner = None
    record = {}
    descriptors = 0

    def finish():
        if not record:
            return
        if owner != pid or record.get("P") not in ("TCP", "UDP"):
            raise DetectionError("lsof socket has no recognized owner/protocol")
        name = record.get("n")
        if not name:
            raise DetectionError("lsof socket has no address")
        state = tcp_state(record.get("state", "")) if record["P"] == "TCP" else None
        if "->" not in name:
            endpoint(name)
            if state == "ESTABLISHED":
                raise DetectionError("established lsof socket has no peer")
            return  # A validated bound/listening address has no client.
        local, peer = name.split("->", 1)
        if state == "ESTABLISHED" and endpoint(peer) is None:
            raise DetectionError("established lsof socket has a wildcard peer")
        item = flow(record["P"].lower(), local, peer)
        if item and (state is None or state == "ESTABLISHED"):
            flows.add(item)

    for line in sample.splitlines():
        if not line:
            continue
        field, value = line[0], line[1:]
        if field == "p":
            finish()
            record = {}
            try:
                owner = int(value)
            except ValueError as exc:
                raise DetectionError("invalid lsof pid") from exc
        elif field == "f":
            finish()
            record = {"fd": value}
            descriptors += 1
        elif field == "T":
            if value.startswith("ST="):
                record["state"] = value[3:]
        elif field in ("P", "n"):
            record[field] = value
        elif field != "c":
            raise DetectionError("unexpected lsof field: " + field)
    finish()
    if sample.strip() and owner != pid:
        raise DetectionError("lsof did not identify requested pid")
    if not descriptors:
        raise DetectionError("lsof returned no socket descriptors")
    return flows


def parse_nettop(sample, pid):
    """Network.framework UDP flows can appear in nettop without a connected lsof fd."""
    rows = list(csv.reader(sample.splitlines()))
    if not rows or rows[0][0] != "":
        raise DetectionError("missing nettop CSV header")
    header = [v.strip() for v in rows[0]]
    state_column = header.index("state") if "state" in header else None
    owner = None
    seen_owner = False
    flows = set()
    for row in rows[1:]:
        if not row:
            continue
        label = row[0].strip()
        match = re.fullmatch(r"(tcp|udp)[46]? (.+)<->(.+)", label)
        if match:
            if owner != pid:
                raise DetectionError("nettop flow outside requested process")
            protocol, local, peer = match.groups()
            state = None
            if protocol == "tcp" and state_column is not None:
                if len(row) <= state_column:
                    raise DetectionError("nettop TCP row is truncated")
                state = tcp_state(row[state_column].strip())
            if state == "ESTABLISHED" and endpoint(peer) is None:
                raise DetectionError("established nettop socket has a wildcard peer")
            # Resolve the peer first so wildcard listeners don't need a TCP state.
            item = flow(protocol, local, peer)
            if item is None:
                continue
            if protocol == "tcp":
                if state is None:
                    raise DetectionError("nettop TCP connection has no state")
                if state != "ESTABLISHED":
                    continue
            flows.add(item)
        else:
            process = re.fullmatch(r".+\.(\d+)", label)
            if not process:
                raise DetectionError("unrecognized nettop row")
            owner = int(process[1])
            seen_owner = seen_owner or owner == pid
    if not seen_owner:
        raise DetectionError("nettop did not identify requested pid")
    return flows


def run(command):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DetectionError("{} unavailable ({})".format(command[0], type(exc).__name__)) from exc


def mirage_pids():
    result = run(["/usr/bin/pgrep", "-x", "Mirage Beacon"])
    if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
        return []
    if result.returncode != 0 or result.stderr.strip():
        raise DetectionError("cannot enumerate Mirage processes")
    try:
        pids = sorted(set(int(pid) for pid in result.stdout.split()))
        if not pids or any(pid <= 0 for pid in pids):
            raise ValueError("no valid pids")
        return pids
    except ValueError as exc:
        raise DetectionError("invalid Mirage pid list") from exc


def snapshot(pids):
    flows, errors = set(), []
    for pid in pids:
        for source, command, parser in (
            ("lsof", ["/usr/sbin/lsof", "-nP", "-a", "-p", str(pid), "-i", "-FpcfPnT"], parse_lsof),
            ("nettop", ["/usr/bin/nettop", "-L", "1", "-n", "-x", "-p", str(pid), "-J", "state"], parse_nettop),
        ):
            try:
                result = run(command)
                # lsof uses 1 for a process with no IP sockets, without diagnostics.
                if source == "lsof" and result.returncode == 1 and not result.stdout and not result.stderr:
                    continue
                if result.returncode != 0 or result.stderr.strip() or not result.stdout.strip():
                    raise DetectionError("{} failed for pid {} (rc={})".format(source, pid, result.returncode))
                flows.update(parser(result.stdout, pid))
            except DetectionError as exc:
                errors.append(str(exc))
    return flows, errors


def decision(unhealthy, flows, errors):
    if flows:
        return "streaming"
    if errors:
        return "unknown"
    return "restart" if unhealthy else "healthy"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--pid", type=int, action="append", help="inspect a specific process, read-only")
    args = parser.parse_args()
    pids = args.pid or []
    try:
        if not args.pid:
            pids = mirage_pids()
        flows, errors = snapshot(pids)
    except DetectionError as exc:
        flows, errors = set(), [str(exc)]
    status = decision(True, flows, errors)
    peers = sorted(set(item.peer for item in flows))
    if args.json:
        print(json.dumps({"status": "clear" if status == "restart" else status,
                          "flows": len(flows), "peers": peers, "pids": pids, "errors": errors}))
    elif status == "streaming":
        print("client streaming " + ", ".join(peers))
    elif status == "unknown":
        print("client detection unavailable: " + "; ".join(errors))
    else:
        print("no client flows")
    return {"restart": 0, "streaming": 10, "unknown": 20}[status]


if __name__ == "__main__":
    raise SystemExit(main())
