import { createRequireInternal } from "./require-internal.ts";
import { createNotifyActivityInsertHandler } from "../notify-activity-insert/handler.ts";
import { createCheckConditionsHandler } from "../check-conditions/handler.ts";
import { createBreakthroughMilestonesHandler } from "../breakthrough-milestones/handler.ts";
import { createDailyResearchBriefHandler } from "../daily-research-brief/handler.ts";
import { createFetchDailyArticlesHandler } from "../fetch-daily-articles/handler.ts";
import { createSyncRaceDirectoryHandler } from "../sync-race-directory/handler.ts";
import type {
  InternalHandlerFactory,
  InternalHandlerOptions,
} from "./internal-handler.ts";

const VALID_SECRET = "0123456789abcdef".repeat(4);

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

const factories: Array<[string, InternalHandlerFactory]> = [
  ["notify-activity-insert", createNotifyActivityInsertHandler],
  ["check-conditions", createCheckConditionsHandler],
  ["breakthrough-milestones", createBreakthroughMilestonesHandler],
  ["daily-research-brief", createDailyResearchBriefHandler],
  ["fetch-daily-articles", createFetchDailyArticlesHandler],
  ["sync-race-directory", createSyncRaceDirectoryHandler],
];

for (const [name, createHandler] of factories) {
  Deno.test(`${name} rejects unauthenticated requests before admin/provider work`, async () => {
    let sideEffects = 0;
    const options: InternalHandlerOptions = {
      authorize: createRequireInternal(() => VALID_SECRET),
    };
    const handler = createHandler(async () => {
      sideEffects += 1;
      await fetch("https://provider.example.test/side-effect");
      return new Response("unexpected");
    }, options);

    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = async () => {
      providerCalls += 1;
      return new Response("unexpected");
    };

    try {
      const response = await handler(new Request("https://example.test", {
        method: "POST",
      }));

      assertEquals(response.status, 401);
      assertEquals(sideEffects, 0);
      assertEquals(providerCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
