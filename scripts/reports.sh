#!/usr/bin/env bash
# Print player reports (chat moderation) collected on the server. Usage: scripts/reports.sh [-n COUNT]
n=100000
[ "$1" = "-n" ] && n="$2"
ssh root@80.47.237.83 "tail -n $n /var/lib/run-kitty-run/reports.jsonl 2>/dev/null" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const lines = s.split("\n").filter(Boolean);
  if (!lines.length) return console.log("No reports yet.");
  for (const l of lines) {
    try {
      const r = JSON.parse(l), p = r.reported || {}, b = r.reporter || {};
      console.log(`\n${r.at}  [${r.reason}] room ${r.room || "-"}: ${p.name} (#${p.id}, ${p.app} ${p.ver || ""}, ${p.ip}) reported by ${b.name} (#${b.id}, ${b.app})`);
      for (const c of p.chat || []) console.log(`  ${c.at.slice(11, 19)} ${c.room}  ${c.text}`);
    } catch { console.log(l); }
  }
  console.log(`\n${lines.length} report(s)`);
});'
