# Desktop keyboard focus under the sticky workbench header

```sh
RUN_BROWSER_SMOKE=1 CHROMIUM_PATH=/path/to/chromium node --test --test-concurrency=1 test/browser-release-focus-obscuration.test.js
```

In the composed synthetic SQLite release at 1280 × 650 CSS pixels, use the native tab order to reach **Download CSV** in Reporting. Wheel-scroll so that **Reset report filters** sits under the sticky header while CSV is still visible. Press Shift+Tab, then Tab.

Before the fix, Shift+Tab correctly focused Reset but the button was entirely under the 76-pixel header (its bounds were y=14–51) and Chromium hit-tested the header rather than the button. The desktop scroll-padding rule tells the browser to clear the area reserved for the header. In both standard Glass and Solid surfaces, Reset now scrolls fully beneath the header and receives both keyboard-visible focus and the document hit test. Tab returns to the still-visible CSV link. The header remains sticky, and the compact non-sticky layout does not use this scroll padding.

This regression checks one real Chromium viewport, one populated panel and two surface modes. It does not establish forced-colors, every zoom level, every possible header height, every browser engine, or application-wide WCAG conformance.
