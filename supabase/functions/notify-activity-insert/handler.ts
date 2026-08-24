import {
  createInternalHandler,
  type InternalHandlerFactory,
} from "../_shared/internal-handler.ts";

export const createNotifyActivityInsertHandler: InternalHandlerFactory =
  createInternalHandler;
