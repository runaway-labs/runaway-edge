// Shared logging utilities for Edge Functions
// Logs to both console (Supabase dashboard) and app_logs table

import { createClient } from 'jsr:@supabase/supabase-js@2'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  source: string
  function_name: string
  level: LogLevel
  message: string
  user_id?: string
  athlete_id?: number
  request_method?: string
  request_path?: string
  request_body?: Record<string, unknown>
  response_status?: number
  response_body?: Record<string, unknown>
  duration_ms?: number
  error_message?: string
  error_stack?: string
  environment?: string
  metadata?: Record<string, unknown>
}

class EdgeLogger {
  private functionName: string
  private startTime: number
  private supabase: ReturnType<typeof createClient> | null = null

  constructor(functionName: string) {
    this.functionName = functionName
    this.startTime = Date.now()
  }

  private getSupabase() {
    if (!this.supabase) {
      this.supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      )
    }
    return this.supabase
  }

  private async writeLog(entry: Partial<LogEntry>) {
    const fullEntry: LogEntry = {
      source: 'edge-function',
      function_name: this.functionName,
      level: 'info',
      message: '',
      environment: Deno.env.get('ENVIRONMENT') || 'production',
      ...entry
    }

    // Always log to console (shows in Supabase dashboard)
    const icon = {
      debug: '🔍',
      info: 'ℹ️',
      warn: '⚠️',
      error: '❌'
    }[fullEntry.level]

    console.log(`${icon} [${this.functionName}] ${fullEntry.message}`)
    if (fullEntry.metadata) {
      console.log('   Metadata:', JSON.stringify(fullEntry.metadata, null, 2))
    }
    if (fullEntry.error_message) {
      console.error('   Error:', fullEntry.error_message)
    }

    // Also write to app_logs table
    try {
      await this.getSupabase()
        .from('app_logs')
        .insert(fullEntry)
    } catch (e) {
      console.error('Failed to write log to database:', e)
    }
  }

  debug(message: string, metadata?: Record<string, unknown>) {
    this.writeLog({ level: 'debug', message, metadata })
  }

  info(message: string, metadata?: Record<string, unknown>) {
    this.writeLog({ level: 'info', message, metadata })
  }

  warn(message: string, metadata?: Record<string, unknown>) {
    this.writeLog({ level: 'warn', message, metadata })
  }

  error(message: string, error?: Error, metadata?: Record<string, unknown>) {
    this.writeLog({
      level: 'error',
      message,
      error_message: error?.message,
      error_stack: error?.stack,
      metadata
    })
  }

  // Log incoming request
  logRequest(req: Request, body?: unknown, userId?: string) {
    const url = new URL(req.url)
    this.writeLog({
      level: 'info',
      message: `Request: ${req.method} ${url.pathname}`,
      user_id: userId,
      request_method: req.method,
      request_path: url.pathname + url.search,
      request_body: body as Record<string, unknown>,
      metadata: {
        headers: Object.fromEntries(req.headers.entries()),
        origin: req.headers.get('origin')
      }
    })
  }

  // Log outgoing response
  logResponse(req: Request, status: number, body?: unknown, userId?: string) {
    const url = new URL(req.url)
    const duration = Date.now() - this.startTime

    this.writeLog({
      level: status >= 400 ? 'error' : 'info',
      message: `Response: ${req.method} ${url.pathname} - ${status} (${duration}ms)`,
      user_id: userId,
      request_method: req.method,
      request_path: url.pathname,
      response_status: status,
      response_body: body as Record<string, unknown>,
      duration_ms: duration
    })
  }

  // Log external API call
  logExternalApi(service: string, method: string, url: string, status: number, durationMs: number) {
    this.writeLog({
      level: status >= 400 ? 'warn' : 'info',
      message: `External API: ${service} ${method} - ${status} (${durationMs}ms)`,
      metadata: { service, url, status, duration_ms: durationMs }
    })
  }
}

// Factory function to create logger for each function
export function createLogger(functionName: string): EdgeLogger {
  return new EdgeLogger(functionName)
}
