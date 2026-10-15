(() => {
  // Mintlify generates raster favicons. Keep an SVG favicon synchronized with
  // the site's computed highlight color, using favicon.svg as the only source.
  async function initialize() {
    try {
      const response = await fetch('/favicon.svg');
      if (!response.ok) throw new Error(`Icon request failed: ${response.status}`);
      const svg = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
      if (svg.querySelector('parsererror')) throw new Error('Invalid icon SVG');
      let previousColor;
      let iconUrl;
      let frame;

      function update() {
        const logo = document.querySelector('#navbar a:has(> .nav-logo)');
        if (!logo) return;
        const highlight = getComputedStyle(logo).getPropertyValue('--cv-accent').trim();
        if (highlight !== previousColor) {
          svg.documentElement.style.color = highlight;
          iconUrl = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
          previousColor = highlight;
        }
        let icons = [...document.head.querySelectorAll('link[rel~="icon"]')];
        if (!icons.length) {
          const icon = document.createElement('link');
          icon.rel = 'icon';
          document.head.append(icon);
          icons = [icon];
        }
        for (const icon of icons) {
          if (icon.getAttribute('href') === iconUrl) continue;
          icon.type = 'image/svg+xml';
          icon.sizes = 'any';
          icon.href = iconUrl;
        }
      }

      function scheduleUpdate() {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(update);
      }

      new MutationObserver(scheduleUpdate).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style']
      });
      // Also handle favicon links replaced by client-side navigation.
      new MutationObserver(scheduleUpdate).observe(document.head, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href']
      });
      update();
    } catch (error) {
      console.warn('Unable to synchronize the theme icon:', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
