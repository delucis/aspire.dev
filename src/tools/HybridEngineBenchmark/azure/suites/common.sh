# Helpers shared by the suites. run-suite.ps1 puts this text in front of the suite, so the suite is one sh script.
#
# SITES holds "label=url" pairs, for example "node=http://a.azurewebsites.net jint=http://b.azurewebsites.net".
# Every scenario runs against each site in turn, and the order alternates between rounds so that a slow minute
# on the platform does not always land on the same site.

SITES="$*"
PATHS=/app/paths
ENC="Accept-Encoding: gzip, deflate, br"

lg() { dotnet /app/LoadGen.dll "$@"; }

site_label() { echo "${1%%=*}"; }
site_url() { echo "${1#*=}"; }

# Prints the sites in reverse order.
reverse_sites() {
  out=""
  for s in "$@"; do out="$s $out"; done
  echo "$out"
}

# Prints the sites in order for the given round: forward for odd rounds, reversed for even rounds.
sites_for_round() {
  if [ $(($1 % 2)) -eq 1 ]; then echo "$SITES"; else reverse_sites $SITES; fi
}

# load <label> <url> <paths-file> <connections> <duration-seconds> [warmup-seconds] [seed]
load() {
  echo "=== $1"
  lg --url "$2" --paths-file "$PATHS/$3" --connections "$4" --duration "$5" --warmup "${6:-5}" --seed "${7:-1}" \
    --header "$ENC" --label "$1" --out -
}

# sequence <label> <url> <repeat> <paths-file>
sequence() {
  echo "=== $1"
  lg --url "$2" --mode sequence --repeat "$3" --paths-file "$PATHS/$4" --header "$ENC" --label "$1" --out -
}

# Waits until a site answers its health probes so that a suite never measures a start-up.
wait_ready() {
  for pair in $SITES; do
    url=$(site_url "$pair")
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
      if lg --url "$url" --mode sequence --repeat 1 --path /healthz/api-docs --label ready >/dev/null 2>&1 \
        || lg --url "$url" --mode sequence --repeat 1 --path /healthz --label ready >/dev/null 2>&1; then
        echo "ready: $pair"
        break
      fi
      sleep 10
    done
  done
}

echo "#start $(date -u +%Y-%m-%dT%H:%M:%SZ) sites: $SITES"
wait_ready
