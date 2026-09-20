/**
 * Applies the refracting backdrop to every glass card in a window.
 *
 * The displacement map has to be the size of the element it refracts, so
 * this measures each card and writes an inline `backdrop-filter`. Doing it
 * from one place keeps the imperative part contained: the cards themselves
 * stay plain markup, and turning the material off removes the property
 * again rather than leaving a stale filter behind.
 */

import { useEffect } from "react";
import { glassBackdrop } from "./displacement";

/** Matches the settings card radius under the liquid material. */
const RADIUS = 22;
/** How far the refraction reaches in from the rim. */
const DEPTH = 8;
/** Edge displacement in pixels. Past about 60 the corners smear. */
const STRENGTH = 64;
/** Colour fringing. Subtle on purpose; glass this thin barely splits light. */
const ABERRATION = 4;
/** The softening pass behind the refraction. */
const BLUR = 4;

/** Below this a card is either collapsed or mid-layout; skip it. */
const MIN_SIZE = 24;

export function useLiquidGlass(enabled: boolean, selector = ".settings-card"): void {
  useEffect(() => {
    const cards = () => Array.from(document.querySelectorAll<HTMLElement>(selector));

    if (!enabled) {
      for (const el of cards()) el.style.removeProperty("backdrop-filter");
      return;
    }

    const apply = () => {
      for (const el of cards()) {
        const { width, height } = el.getBoundingClientRect();
        if (width < MIN_SIZE || height < MIN_SIZE) continue;
        el.style.backdropFilter = glassBackdrop(
          {
            // whole pixels keep the cache from thrashing on sub-pixel layout
            width: Math.round(width),
            height: Math.round(height),
            radius: RADIUS,
            depth: DEPTH,
            strength: STRENGTH,
            chromaticAberration: ABERRATION,
          },
          BLUR,
        );
      }
    };

    apply();

    // Cards change height when a section expands, so watch them rather than
    // only the window. One observer for all of them; the callback is cheap
    // because the filter itself is cached per size.
    const observer = new ResizeObserver(apply);
    for (const el of cards()) observer.observe(el);
    return () => {
      observer.disconnect();
      for (const el of cards()) el.style.removeProperty("backdrop-filter");
    };
  }, [enabled, selector]);
}
