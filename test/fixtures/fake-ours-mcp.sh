#!/bin/sh
printf '{"leasePid":%s,"proxyPid":%s}\n' "$OURS_CLIENT_PID" "$$" > "$OWNER_PID_RECORD"
while IFS= read -r request; do
  case "$request" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"fake","version":"1"}}}'
      ;;
  esac
done
