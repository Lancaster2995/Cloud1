#!/usr/bin/env python3
"""Prints the UDID of the newest available iPhone simulator (prefers plain 'iPhone NN')."""
import json, re, subprocess

devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"]))["devices"]
candidates = []
for runtime, items in devices.items():
    m = re.search(r"iOS-(\d+)-(\d+)", runtime)
    if not m:
        continue
    version = (int(m.group(1)), int(m.group(2)))
    for d in items:
        if d["name"].startswith("iPhone"):
            plain = 1 if re.fullmatch(r"iPhone \d+", d["name"]) else 0
            candidates.append((version, plain, d["name"], d["udid"]))
candidates.sort()
print(candidates[-1][3])
