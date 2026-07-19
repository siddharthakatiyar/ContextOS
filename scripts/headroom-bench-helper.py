#!/usr/bin/env python3
"""JSONL helper for ab-4way-benchmark: headroom_compress + headroom_read."""
from __future__ import annotations

import asyncio
import json
import os
import sys

os.environ.setdefault("HEADROOM_MCP_READ", "on")

from headroom.ccr.mcp_server import HeadroomMCPServer  # noqa: E402


async def main() -> None:
    srv = HeadroomMCPServer(check_proxy=False)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        op = req.get("op")
        try:
            if op == "compress":
                result = srv._compress_content(req["content"])
                # Agent-visible tool payload (same shape as MCP JSON response)
                out = {
                    "ok": True,
                    "compressed": result["compressed"],
                    "hash": result["hash"],
                    "original_tokens": result["original_tokens"],
                    "compressed_tokens": result["compressed_tokens"],
                    "tokens_saved": result["tokens_saved"],
                    "savings_percent": result["savings_percent"],
                    "transforms": result["transforms"],
                    "tool_text": json.dumps(
                        {
                            "compressed": result["compressed"],
                            "hash": result["hash"],
                            "original_tokens": result["original_tokens"],
                            "compressed_tokens": result["compressed_tokens"],
                            "tokens_saved": result["tokens_saved"],
                            "savings_percent": result["savings_percent"],
                            "transforms": result["transforms"],
                            "note": result["note"],
                        },
                        indent=2,
                    ),
                }
            elif op == "read":
                texts = await srv._handle_read(
                    {"file_path": req["file_path"], "fresh": bool(req.get("fresh", False))}
                )
                tool_text = texts[0].text if texts else ""
                out = {"ok": True, "tool_text": tool_text}
            else:
                out = {"ok": False, "error": f"unknown op {op}"}
        except Exception as e:  # noqa: BLE001
            out = {"ok": False, "error": str(e)}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
