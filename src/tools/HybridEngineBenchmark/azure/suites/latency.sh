# The time one visitor waits for a single page, one request at a time on one connection.
#
# Per round and site: the round trip of the health probe, 20 static pages, 150 API pages and 100 Markdown endpoints,
# each requested 5 times. The first request of a page is normally a cache miss, so the 5 requests show the cost of a
# render and of a cached answer. Each round uses pages that no earlier round requested.

for round in 1 2 3; do
  for pair in $(sites_for_round $round); do
    label=$(site_label "$pair")
    url=$(site_url "$pair")
    sequence "rtt-$label-r$round" "$url" 100 healthz.txt
    sequence "static-$label-r$round" "$url" 5 static-20.txt
    sequence "html-$label-r$round" "$url" 5 latency-html-r$round.txt
    sequence "md-$label-r$round" "$url" 5 latency-md-r$round.txt
  done
done

echo "#end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
