#!/usr/bin/env bash
# Print player feedback collected on the server. Usage: scripts/feedback.sh [-n COUNT]
n=100000
[ "$1" = "-n" ] && n="$2"
ssh root@80.47.237.83 "tail -n $n /var/lib/run-kitty-run/feedback.jsonl 2>/dev/null" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const lines = s.split("\n").filter(Boolean);
  if (!lines.length) return console.log("No feedback yet.");
  for (const l of lines) { try { const f = JSON.parse(l); console.log(`\n${f.at}  ${f.name || "?"} (${f.mode || "?"}, level ${f.level ?? "?"})\n  ${f.text.replace(/\n/g, "\n  ")}`); } catch { console.log(l); } }
  console.log(`\n${lines.length} message(s)`);
});'
