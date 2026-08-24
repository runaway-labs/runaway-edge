// Pre-Race Alerts MVP: Resend Email Wrapper

import { DeliveryResult } from "./types.ts";

const RESEND_API_URL = "https://api.resend.com/emails";

interface ResendResponse {
  id?: string;
  message?: string;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  idempotencyKey: string,
): Promise<DeliveryResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("FROM_EMAIL");

  if (!apiKey || !fromEmail) {
    return {
      success: false,
      error: "Missing Resend configuration (RESEND_API_KEY or FROM_EMAIL)",
      retryable: false,
    };
  }

  // Basic email validation
  if (!isValidEmail(to)) {
    return {
      success: false,
      error: `Invalid email address: ${to}`,
      retryable: false,
    };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject: subject,
        text: body,
        // For MVP, using plain text. HTML templates can be added in V2.
      }),
    });

    const data: ResendResponse = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: data.message ?? `Resend error: ${response.status}`,
        retryable: response.status === 409 || response.status === 429 || response.status >= 500,
      };
    }

    return {
      success: true,
      provider_message_id: data.id,
    };
  } catch (error) {
    console.error("Error sending email via Resend:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error sending email",
      retryable: true,
    };
  }
}

// Basic email validation
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Format email for race alert
export function formatAlertEmail(
  raceName: string,
  raceDate: string,
  subject: string,
  message: string
): { subject: string; body: string } {
  const emailSubject = `[${raceName}] ${subject}`;

  const emailBody = `
Race Alert: ${raceName}
Date: ${raceDate}
---------------------------------

${message}

---------------------------------
This is an automated alert from the race director.

If you have questions about this alert, please contact the race organizer directly.
  `.trim();

  return {
    subject: emailSubject,
    body: emailBody,
  };
}
