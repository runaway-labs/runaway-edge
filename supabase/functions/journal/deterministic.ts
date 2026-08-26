export function buildJournalNarrative(input: {
  activitiesCount: number
  totalDistanceKm: number
  totalMinutes: number
  totalElevationM: number
  longestDistanceKm: number
}): string {
  const hours = Math.floor(input.totalMinutes / 60)
  const minutes = input.totalMinutes % 60
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
  const consistency = input.activitiesCount >= 4
    ? 'The frequency gave the week a consistent rhythm.'
    : input.activitiesCount >= 2
      ? 'The week established a useful training rhythm.'
      : 'This was a light week, so the next step is simply to rebuild consistency.'

  return [
    `You completed ${input.activitiesCount} activities covering ${input.totalDistanceKm.toFixed(1)} km in ${duration}.`,
    `Your longest session was ${input.longestDistanceKm.toFixed(1)} km, with ${Math.round(input.totalElevationM)} m of climbing across the week.`,
    consistency,
    'Carry the useful rhythm forward without increasing both volume and intensity at the same time.',
  ].join(' ')
}
