// POST /api/baskets — save a basket. Contract: docs/API.md section 3.
import { createBasketHandlers } from "@/lib/baskets/handler";

const handlers = createBasketHandlers();

export const POST = handlers.save;
export const OPTIONS = handlers.options;
