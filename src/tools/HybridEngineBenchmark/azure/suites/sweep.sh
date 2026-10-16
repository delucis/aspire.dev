# How throughput and latency change with the number of concurrent connections.
#
# Closed-loop connections pick pages at random from 20,000 API pages, so nearly every request is a cache miss and the
# result is the rendering capacity of the site. Each step runs 30 measured seconds after 5 seconds of warm-up.
#
# Every step has its own seed. With one seed for all steps, connection 0 would ask for the same pages in every step and
# later steps would hit the caches that earlier steps filled. Both sites get the same seed in a step, so they are asked for
# the same pages.
#
# A first pass at 16 connections wakes every instance of both sites, so a cold engine does not land in the first steps.
# It is not reported.

for pair in $SITES; do
  echo "=== warm-up $(site_label "$pair")"
  lg --url "$(site_url "$pair")" --paths-file "$PATHS/uniform-html.txt" --connections 16 --duration 20 --warmup 0 --seed 99 \
    --header "$ENC" --label warm-up
done
sleep 10

n=0
for connections in 1 2 4 8 16 32 64; do
  n=$((n + 1))
  for pair in $(sites_for_round $n); do
    load "sweep-$(site_label "$pair")-c$connections" "$(site_url "$pair")" uniform-html.txt "$connections" 30 5 $((n * 1000))
    sleep 5
  done
done

echo "#end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
