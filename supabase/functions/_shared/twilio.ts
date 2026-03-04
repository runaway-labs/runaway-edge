// Pre-Race Alerts MVP: Twilio SMS Wrapper

import { DeliveryResult } from "./types.ts";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

interface TwilioMessageResponse {
  sid: string;
  status: string;
  error_code: number | null;
  error_message: string | null;
}

export async function sendSms(
  to: string,
  body: string
): Promise<DeliveryResult> {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  const fromNumber = Deno.env.get("TWILIO_PHONE_NUMBER");

  if (!accountSid || !authToken || !fromNumber) {
    return {
      success: false,
      error: "Missing Twilio configuration (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER)",
    };
  }

  // Normalize phone number - ensure it has country code
  const normalizedTo = normalizePhoneNumber(to);

  if (!normalizedTo) {
    return {
      success: false,
      error: `Invalid phone number: ${to}`,
    };
  }

  const url = `${TWILIO_API_BASE}/${accountSid}/Messages.json`;

  const formData = new URLSearchParams();
  formData.append("To", normalizedTo);
  formData.append("From", fromNumber);
  formData.append("Body", body);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    const data: TwilioMessageResponse = await response.json();

    if (!response.ok || data.error_code) {
      return {
        success: false,
        error: data.error_message ?? `Twilio error: ${response.status}`,
      };
    }

    return {
      success: true,
      provider_message_id: data.sid,
    };
  } catch (error) {
    console.error("Error sending SMS via Twilio:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error sending SMS",
    };
  }
}

// Normalize phone number to E.164 format
function normalizePhoneNumber(phone: string): string | null {
  // Remove all non-numeric characters except leading +
  const cleaned = phone.replace(/[^\d+]/g, "");

  // If already has country code
  if (cleaned.startsWith("+")) {
    return cleaned.length >= 11 ? cleaned : null;
  }

  // If starts with 1 (US/Canada), add +
  if (cleaned.startsWith("1") && cleaned.length === 11) {
    return `+${cleaned}`;
  }

  // If 10 digits, assume US and add +1
  if (cleaned.length === 10) {
    return `+1${cleaned}`;
  }

  // Otherwise invalid
  return null;
}

// Format SMS message with race context
export function formatAlertSms(
  raceName: string,
  subject: string,
  message: string
): string {
  const header = `[${raceName}] ${subject}`;
  const fullMessage = `${header}\n\n${message}`;

  // Twilio SMS limit is 1600 characters, but messages over 160 are split
  // Keep under 320 for 2-segment message
  if (fullMessage.length > 320) {
    return fullMessage.substring(0, 317) + "...";
  }

  return fullMessage;
}
