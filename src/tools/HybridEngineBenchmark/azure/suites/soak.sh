# A sustained, crawler-like load: 16 connections over HTML and Markdown pages of the whole API reference.
#
# SOAK_SECONDS sets the measured length per site (default 600). The per-second throughput in the report shows whether
# a site stays steady, slows down as memory grows, or fails and restarts.

for pair in $SITES; do
  load "soak-$(site_label "$pair")" "$(site_url "$pair")" crawl-all.txt 16 "${SOAK_SECONDS:-600}" 10
  sleep 30
done

echo "#end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
