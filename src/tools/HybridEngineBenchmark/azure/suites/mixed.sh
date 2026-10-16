# Workloads that look more like real traffic than a sweep over every page.
#
# zipf     API pages with a skewed popularity, so a few pages are requested often and the caches work
# hot      50 API pages only, so after the first requests every answer comes from a cache
# md       Markdown endpoints of the API pages
# static   documentation pages that are plain files in both deployments

scenario() { # name paths-file connections seconds round
  for pair in $(sites_for_round "$5"); do
    load "$1-$(site_label "$pair")" "$(site_url "$pair")" "$2" "$3" "$4" 5
    sleep 5
  done
}

scenario zipf zipf-html.txt 32 60 1
scenario hot hot-50.txt 32 30 2
scenario md all-md.txt 16 30 1
scenario static static-html.txt 16 20 2

echo "#end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
