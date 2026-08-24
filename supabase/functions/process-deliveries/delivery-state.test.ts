import {
  beginDeliverySubmission,
  DeliveryStateError,
  finalizeDelivery,
  type DeliveryStateClient,
} from "./delivery-state.ts";

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function expectStateError(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof DeliveryStateError)) {
      throw error;
    }
    return;
  }
  throw new Error("Expected DeliveryStateError");
}

function client(result: { data: boolean | null; error: unknown }): DeliveryStateClient {
  return {
    rpc: async () => result,
  };
}

Deno.test("beginDeliverySubmission rejects database errors before provider work", async () => {
  await expectStateError(() =>
    beginDeliverySubmission(client({ data: null, error: new Error("database unavailable") }), {
      deliveryId: "delivery-1",
      claimGeneration: 2,
    })
  );
});

Deno.test("beginDeliverySubmission rejects a stale fencing token", async () => {
  await expectStateError(() =>
    beginDeliverySubmission(client({ data: false, error: null }), {
      deliveryId: "delivery-1",
      claimGeneration: 2,
    })
  );
});

Deno.test("finalizeDelivery rejects database errors instead of reporting success", async () => {
  await expectStateError(() =>
    finalizeDelivery(client({ data: null, error: new Error("database unavailable") }), {
      deliveryId: "delivery-1",
      claimGeneration: 2,
      status: "sent",
      providerMessageId: "provider-1",
      errorMessage: null,
      sentAt: "2026-08-24T00:00:00.000Z",
    })
  );
});

Deno.test("finalizeDelivery rejects stale workers instead of reporting success", async () => {
  await expectStateError(() =>
    finalizeDelivery(client({ data: false, error: null }), {
      deliveryId: "delivery-1",
      claimGeneration: 1,
      status: "failed",
      providerMessageId: null,
      errorMessage: "failed",
      sentAt: null,
    })
  );
});

Deno.test("finalizeDelivery accepts only an acknowledged fenced transition", async () => {
  const calls: unknown[] = [];
  const stateClient: DeliveryStateClient = {
    rpc: async (name, args) => {
      calls.push([name, args]);
      return { data: true, error: null };
    },
  };

  await finalizeDelivery(stateClient, {
    deliveryId: "delivery-1",
    claimGeneration: 3,
    status: "retryable",
    providerMessageId: null,
    errorMessage: "try again",
    sentAt: null,
  });

  assertEquals(calls, [[
    "finalize_delivery",
    {
      delivery_id: "delivery-1",
      claim_generation: 3,
      final_status: "retryable",
      provider_message_id: null,
      error_message: "try again",
      sent_at: null,
    },
  ]]);
});
