"""JSON transport for OpenCode; the classifier is shared with native hooks."""
import json
import sys

from statev2_guard import classify_detail


def main():
    event = json.load(sys.stdin)
    rule, detail = classify_detail(event["command"], event.get("cwd"))
    print(json.dumps({"rule": rule, "detail": detail}))


if __name__ == "__main__":
    main()
