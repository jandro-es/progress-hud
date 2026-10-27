// Drawings for the surfaces that carry `Svg`. They are drawn as images, so
// they hold no text and use colours that read on light and dark alike.

export const ACCENT = '#D97757'
export const GOOD = '#3FAE7A'
export const WARN = '#E0A23A'
export const BAD = '#D9534F'
const TRACK = 'rgba(128,128,128,0.22)'

export function ring(fraction: number, size = 72, color = ACCENT): string {
  const stroke = 8
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const f = Math.min(1, Math.max(0, fraction))
  const centre = size / 2

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${centre}" cy="${centre}" r="${r}" fill="none" stroke="${TRACK}" stroke-width="${stroke}"/>` +
    `<circle cx="${centre}" cy="${centre}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" ` +
    `transform="rotate(-90 ${centre} ${centre})"/>` +
    `</svg>`
  )
}

export function meterBar(fraction: number | undefined, width = 220, color = ACCENT, height = 6): string {
  const r = height / 2
  const inner =
    fraction === undefined
      ? // No estimate yet: a striped, indeterminate bar.
        `<rect x="0" y="0" width="${width}" height="${height}" rx="${r}" fill="url(#s)"/>`
      : `<rect x="0" y="0" width="${Math.max(height, width * Math.min(1, fraction)).toFixed(1)}" height="${height}" rx="${r}" fill="${color}"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><pattern id="s" width="8" height="${height}" patternUnits="userSpaceOnUse" patternTransform="skewX(-30)">` +
    `<rect width="4" height="${height}" fill="${color}" opacity="0.55"/></pattern></defs>` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${r}" fill="${TRACK}"/>` +
    inner +
    `</svg>`
  )
}

export function area(values: readonly number[], width = 220, height = 36, color = ACCENT): string {
  const max = Math.max(...values, 0)
  const n = values.length
  const step = n > 1 ? width / (n - 1) : width
  const points = values.map((v, i) => {
    const y = max <= 0 ? height - 1 : height - 1 - (v / max) * (height - 4)

    return `${(i * step).toFixed(1)},${y.toFixed(1)}`
  })
  const line = points.join(' ')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${color}" stop-opacity="0.45"/>` +
    `<stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>` +
    `<polygon points="0,${height} ${line} ${width},${height}" fill="url(#g)"/>` +
    `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `</svg>`
  )
}
