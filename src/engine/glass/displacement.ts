/**
 * Real refraction for glass surfaces.
 *
 * A blur scatters light. Glass bends it, and that difference is most of
 * what separates Apple's Liquid Glass from ordinary frosted panels. The
 * only way to bend pixels in CSS is an SVG `feDisplacementMap` used as a
 * backdrop filter: a generated image encodes how far to push each pixel,
 * red for the x axis and green for the y, and the filter samples the
 * backdrop through it.
 *
 * Technique from "Liquid Glass in CSS and SVG" by ekino, as used in
 * TechnoTalksDev/liquid-glass:
 * https://medium.com/ekino-france/liquid-glass-in-css-and-svg-839985fcb88d
 *
 * The map has to match the element it sits on, so every distinct size
 * needs its own data URI. They are cached, because regenerating one per
 * resize frame is what makes this technique expensive.
 */

export interface GlassOptions {
  width: number;
  height: number;
  /** Corner radius, so the gradients bend where the corners bend. */
  radius: number;
  /** How far in from the edge the refraction reaches. */
  depth: number;
  /** Displacement distance in pixels at the edge. */
  strength: number;
  /** Splits the channels slightly, the way thick glass fringes colour. */
  chromaticAberration: number;
}

/**
 * The map itself. Mid grey means no displacement; the red and green
 * ramps at the edges push pixels inward, and the blurred rounded rect in
 * the middle flattens everything back to neutral so only a band around
 * the rim refracts.
 */
function displacementMap({ width, height, radius, depth }: Omit<GlassOptions, "strength" | "chromaticAberration">): string {
  return (
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg height="${height}" width="${width}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
<style>.mix { mix-blend-mode: screen; }</style>
<defs>
<linearGradient id="Y" x1="0" x2="0" y1="${Math.ceil((radius / height) * 15)}%" y2="${Math.floor(100 - (radius / height) * 15)}%">
<stop offset="0%" stop-color="#0F0"/><stop offset="100%" stop-color="#000"/>
</linearGradient>
<linearGradient id="X" x1="${Math.ceil((radius / width) * 15)}%" x2="${Math.floor(100 - (radius / width) * 15)}%" y1="0" y2="0">
<stop offset="0%" stop-color="#F00"/><stop offset="100%" stop-color="#000"/>
</linearGradient>
</defs>
<rect x="0" y="0" height="${height}" width="${width}" fill="#808080"/>
<g filter="blur(2px)">
<rect x="0" y="0" height="${height}" width="${width}" fill="#000080"/>
<rect x="0" y="0" height="${height}" width="${width}" fill="url(#Y)" class="mix"/>
<rect x="0" y="0" height="${height}" width="${width}" fill="url(#X)" class="mix"/>
<rect x="${depth}" y="${depth}" height="${height - 2 * depth}" width="${width - 2 * depth}" fill="#808080" rx="${radius}" ry="${radius}" filter="blur(${depth}px)"/>
</g>
</svg>`,
    )
  );
}

/** Cache keyed on the geometry, so a card that keeps its size keeps its filter. */
const cache = new Map<string, string>();

/** Bound the cache; a window being dragged to resize can mint a lot of these. */
const MAX_CACHED = 48;

/**
 * A `url(...)` value for `backdrop-filter`. Three displacement passes at
 * slightly different strengths, recombined per channel, give the colour
 * fringing real glass has at its edges.
 */
export function displacementFilter(options: GlassOptions): string {
  const { width, height, radius, depth, strength, chromaticAberration } = options;
  const key = `${width}x${height}r${radius}d${depth}s${strength}c${chromaticAberration}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const map = displacementMap({ width, height, radius, depth });
  const channel = (scale: number, matrix: string, result: string) =>
    `<feDisplacementMap in="SourceGraphic" in2="displacementMap" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
<feColorMatrix type="matrix" values="${matrix}" result="${result}"/>`;

  const url =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg height="${height}" width="${width}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
<defs><filter id="displace" color-interpolation-filters="sRGB">
<feImage x="0" y="0" height="${height}" width="${width}" href="${map}" result="displacementMap"/>
${channel(strength + chromaticAberration * 2, "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0", "displacedR")}
${channel(strength + chromaticAberration, "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0", "displacedG")}
${channel(strength, "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0", "displacedB")}
<feBlend in="displacedR" in2="displacedG" mode="screen"/>
<feBlend in2="displacedB" mode="screen"/>
</filter></defs>
</svg>`,
    ) +
    "#displace";

  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(key, url);
  return url;
}

/** The full backdrop-filter stack: refract, then soften, then light it. */
export function glassBackdrop(options: GlassOptions, blur: number): string {
  return [
    `blur(${(blur / 2).toFixed(2)}px)`,
    `url('${displacementFilter(options)}')`,
    `blur(${blur.toFixed(2)}px)`,
    "brightness(1.08)",
    "saturate(1.5)",
  ].join(" ");
}
