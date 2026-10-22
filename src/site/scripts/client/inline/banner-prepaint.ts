// Inline (pre-paint) script placed right after the banner element, from Banner.astro's is:inline
// data-banner-prepaint script, unchanged: hides an expired, dismissed or auto-dismissed banner before the
// first paint. banner.ts applies the same decision and wires the dismiss button.
// @ts-nocheck
  (function () {
    var banner = document.querySelector('[data-aspire-banner]');
    if (!banner) return;
    var data = banner.dataset;
    var now = Date.now();
    var hide = data.expiresOn ? now >= Number(data.expiresOn) : false;
    try {
      if (!hide) hide = window.localStorage.getItem(data.dismissKey) === 'true';
      if (!hide && data.autoDismissDays) {
        var raw = window.localStorage.getItem(data.firstSeenKey);
        var firstSeen = raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw) : 0;
        hide =
          firstSeen > 0 &&
          firstSeen <= now &&
          now >= firstSeen + Number(data.autoDismissDays) * 86400000;
      }
    } catch (e) {}
    if (hide) {
      banner.hidden = true;
      banner.dataset.bannerState = 'closed';
    }
  })();
