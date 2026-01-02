// Activity summarizer utilities
// Converts raw activity data into natural language summaries

import type { Activity } from './types.ts'

export class ActivitySummarizer {
  /**
   * Convert meters to miles
   */
  static metersToMiles(meters: number | null | undefined): string | null {
    if (!meters) return null
    return (meters * 0.000621371).toFixed(2)
  }

  /**
   * Convert meters/second to minutes per mile
   */
  static mpsToMinPerMile(mps: number | null | undefined): string | null {
    if (!mps || mps === 0) return null
    const milesPerHour = mps * 2.23694
    const minutesPerMile = 60 / milesPerHour
    const minutes = Math.floor(minutesPerMile)
    const seconds = Math.round((minutesPerMile - minutes) * 60)
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  /**
   * Convert seconds to readable duration
   */
  static secondsToTime(seconds: number | null | undefined): string | null {
    if (!seconds) return null
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  /**
   * Determine HR zone (rough estimate based on typical zones)
   */
  static getHRZone(avgHR: number, maxHR?: number): string | null {
    if (!avgHR) return null

    const estimatedMaxHR = maxHR || 185
    const percentage = (avgHR / estimatedMaxHR) * 100

    if (percentage < 60) return 'Zone 1 (easy)'
    if (percentage < 70) return 'Zone 2 (aerobic)'
    if (percentage < 80) return 'Zone 3 (tempo)'
    if (percentage < 90) return 'Zone 4 (threshold)'
    return 'Zone 5 (max effort)'
  }

  /**
   * Generate comprehensive activity summary
   */
  static generateSummary(activity: Activity): string {
    const parts: string[] = []

    // Activity name
    if (activity.name) {
      parts.push(activity.name)
    }

    // Date
    const date = new Date(activity.activity_date || '')
    parts.push(`on ${date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })}`)

    // Distance and time
    const miles = this.metersToMiles(activity.distance)
    const duration = this.secondsToTime(activity.moving_time || activity.elapsed_time)
    if (miles && duration) {
      parts.push(`${miles} miles in ${duration}`)
    }

    // Pace
    const pace = this.mpsToMinPerMile(activity.average_speed)
    if (pace) {
      parts.push(`averaging ${pace}/mile pace`)
    }

    // Heart rate
    if (activity.average_heart_rate) {
      const hrZone = this.getHRZone(activity.average_heart_rate, activity.max_heart_rate)
      parts.push(
        `HR averaged ${activity.average_heart_rate} bpm${activity.max_heart_rate ? ` (max ${activity.max_heart_rate})` : ''}${hrZone ? ` in ${hrZone}` : ''}`
      )
    }

    // Elevation
    if (activity.elevation_gain && activity.elevation_gain > 10) {
      const elevFt = Math.round(activity.elevation_gain * 3.28084)
      parts.push(`with ${elevFt}ft of elevation gain`)
    }

    return parts.join('. ') + '.'
  }

  /**
   * Generate a more detailed summary for coaching purposes
   */
  static generateDetailedSummary(activity: Activity): string {
    const summary = this.generateSummary(activity)
    const insights: string[] = []

    // Pace variability analysis
    if (activity.average_speed && activity.max_speed) {
      const avgMph = activity.average_speed * 2.23694
      const maxMph = activity.max_speed * 2.23694
      const variability = ((maxMph - avgMph) / avgMph) * 100

      if (variability > 50) {
        insights.push('High pace variability suggests intervals or terrain changes')
      } else if (variability < 15) {
        insights.push('Very consistent pacing - good tempo control')
      }
    }

    // HR efficiency analysis
    if (activity.average_heart_rate && activity.average_speed) {
      const efficiency = activity.average_speed / activity.average_heart_rate
      insights.push(`Cardiovascular efficiency: ${efficiency.toFixed(4)} m/s per bpm`)
    }

    if (insights.length > 0) {
      return `${summary}\n\nAnalysis: ${insights.join('. ')}.`
    }

    return summary
  }
}
