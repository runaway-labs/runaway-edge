export interface ElevationPoint {
  distance: number
  elevation: number
  grade: number
}

export function findGpxUrlInHtml(html: string, baseUrl: string): string | null {
  const attributeMatch = html.match(/(?:href|src)\s*=\s*["']([^"']+\.gpx(?:\?[^"']*)?)["']/i)
  const rawMatch = html.match(/https?:\/\/[^\s"'<>]+\.gpx(?:\?[^\s"'<>]*)?/i)
  const candidate = attributeMatch?.[1] ?? rawMatch?.[0]
  if (!candidate) return null
  try {
    const url = new URL(candidate, baseUrl)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

export function deriveTacticalInsights(points: ElevationPoint[]): Array<{ mile: number; description: string }> {
  const insights: Array<{ mile: number; description: string }> = []
  for (const point of points) {
    if (Math.abs(point.grade) < 3) continue
    if (insights.some((item) => Math.abs(item.mile - point.distance) < 0.25)) continue
    const description = point.grade > 0
      ? 'A meaningful climb begins here. Shorten your stride and hold effort rather than pace.'
      : 'A meaningful downhill begins here. Stay quick and controlled without overstriding.'
    insights.push({ mile: point.distance, description })
    if (insights.length === 5) break
  }
  return insights
}
