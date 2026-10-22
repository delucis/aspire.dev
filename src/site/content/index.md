---
title: Aspire
giscus: false
head:
  - tag: title
    content: 'Aspire: Compose distributed apps in code'
description: Model, run, observe, and deploy distributed applications with Aspire's agent-ready, code-first application model.
layout: splash
editUrl: false
prev: false
next: false
banner:
  content: |
    <strong>✨ Aspire 13.6 is available!</strong> — <a href="/whats-new/aspire-13-6/">Explore the latest features and improvements</a>
bannerAutoDismissAfterDays: 14
hero:
  title: Compose distributed apps in code.
  tagline: Model, run, observe, and deploy distributed applications from one code-first control plane.
  image:
    alt: Aspire logo
    file: /assets/images/aspire-hero.png
  actions:
    - text: Try Aspire
      link: /get-started/first-app/
    - text: Explore Docs
      link: /docs/
      variant: secondary
# home: the splash layout renders HomeHero (templates/partials/home/home-hero.liquid) instead of Starlight's hero
# (the Astro Hero override did it for isHomepage(): the root and locale indexes, which set it too).
home: true
# The body is HTML from partials (the Astro page rendered <HomePage />): Markdown would end its HTML blocks at the
# blank lines of the code samples.
markdown: false
---
{% include "partials/home/home-page.liquid" %}
