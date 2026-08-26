export interface DeliveryStateClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: boolean | null; error: unknown }>;
}

export class DeliveryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryStateError";
  }
}

export interface DeliveryFence {
  deliveryId: string;
  claimGeneration: number;
}

export interface DeliveryFinalization extends DeliveryFence {
  status: "sent" | "retryable" | "failed";
  providerMessageId: string | null;
  errorMessage: string | null;
  sentAt: string | null;
}

async function requireAcknowledgedTransition(
  transition: Promise<{ data: boolean | null; error: unknown }>,
  message: string,
): Promise<void> {
  const { data, error } = await transition;
  if (error || data !== true) {
    throw new DeliveryStateError(message);
  }
}

export async function beginDeliverySubmission(
  client: DeliveryStateClient,
  fence: DeliveryFence,
): Promise<void> {
  await requireAcknowledgedTransition(
    client.rpc("begin_delivery_submission", {
      delivery_id: fence.deliveryId,
      claim_generation: fence.claimGeneration,
    }),
    "Unable to begin the fenced provider submission",
  );
}

export async function finalizeDelivery(
  client: DeliveryStateClient,
  finalization: DeliveryFinalization,
): Promise<void> {
  await requireAcknowledgedTransition(
    client.rpc("finalize_delivery", {
      delivery_id: finalization.deliveryId,
      claim_generation: finalization.claimGeneration,
      final_status: finalization.status,
      provider_message_id: finalization.providerMessageId,
      error_message: finalization.errorMessage,
      sent_at: finalization.sentAt,
    }),
    "Unable to finalize the fenced delivery",
  );
}
