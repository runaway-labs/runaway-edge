// Shared type definitions for Edge Functions

export interface Activity {
  id: number
  athlete_id: number
  activity_type_id?: number
  name?: string
  distance?: number
  moving_time?: number
  elapsed_time?: number
  activity_date?: string
  elevation_gain?: number
  average_speed?: number
  max_speed?: number
  average_heart_rate?: number
  max_heart_rate?: number
  map_summary_polyline?: string
  type?: string
}

export interface StravaToken {
  athlete_id: number
  access_token: string
  refresh_token: string
  expires_at: string
}

export interface Conversation {
  id: string
  athlete_id: number
  created_at: string
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}
