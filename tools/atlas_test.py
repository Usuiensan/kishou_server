#!/usr/bin/env python3
"""Send manual atlas test operations to the loopback-only service API."""
import argparse
import json
from pathlib import Path
import sys
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def request(base: str, path: str, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"content-type": "application/json"} if payload is not None else {}
    req = Request(base.rstrip("/") + path, data=data, headers=headers, method="POST" if payload is not None else "GET")
    with urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def resolve_xml_files(scenario: dict, source: Path) -> dict:
    result = json.loads(json.dumps(scenario))
    for step in result.get("steps", []):
        for event in step.get("events", []):
            if "xmlFile" in event:
                file = Path(event.pop("xmlFile"))
                if not file.is_absolute():
                    local = source.parent / file
                    file = local if local.is_file() else ROOT / file
                event["xml"] = file.read_text(encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8766")
    sub = parser.add_subparsers(dest="command", required=True)
    event = sub.add_parser("event", help="submit one or more JMA XML files in order")
    event.add_argument("files", nargs="+", type=Path)
    mode = sub.add_parser("mode", help="change metadata mode and flags")
    for name in ("flags", "mode", "opacity", "lower_x", "lower_y"):
        mode.add_argument("--" + name.replace("_", "-"), type=int)
    scenario = sub.add_parser("scenario", help="run a JSON scenario file")
    scenario.add_argument("file", type=Path)
    sub.add_parser("reset", help="clear displayed layers and restore metadata defaults")
    sub.add_parser("status", help="show service, child process, and scenario status")
    args = parser.parse_args()

    if args.command == "event":
        payload = {"events": [{"xml": file.read_text(encoding="utf-8")} for file in args.files]}
        path = "/test/events"
    elif args.command == "mode":
        payload = {key: value for key, value in vars(args).items()
                   if key in {"flags", "mode", "opacity", "lower_x", "lower_y"} and value is not None}
        path = "/test/mode"
    elif args.command == "scenario":
        payload = resolve_xml_files(json.loads(args.file.read_text(encoding="utf-8")), args.file.resolve())
        path = "/test/scenarios/run"
    elif args.command == "reset":
        payload, path = {}, "/test/reset"
    else:
        print(json.dumps(request(args.url, "/test/status"), ensure_ascii=False, indent=2))
        return
    print(json.dumps(request(args.url, path, payload), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"atlas test operation failed: {error}", file=sys.stderr)
        sys.exit(1)
