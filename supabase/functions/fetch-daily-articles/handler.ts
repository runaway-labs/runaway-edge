import {
  createInternalHandler,
  type InternalHandlerFactory,
} from "../_shared/internal-handler.ts";

export const createFetchDailyArticlesHandler: InternalHandlerFactory =
  createInternalHandler;
