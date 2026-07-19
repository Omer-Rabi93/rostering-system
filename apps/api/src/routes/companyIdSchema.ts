// The one shared definition of the `companyId` request field every company-scoped route parses
// (rosters, staffing requirements, availability grid, workforce CSV import/export). Previously
// each router declared its own structurally-identical copy — one definition means the coercion
// rule (positive int, string-coerced) can never drift between routes.

import { z } from 'zod';

const companyIdObject = z.object({ companyId: z.coerce.number().int().positive() });

/** `{ companyId }` parsed from a query string. Strict: an unknown extra query param is a 400 —
 * every company-scoped GET/PUT sender (see `apps/web/src/api/*.api.ts`) passes exactly this one
 * param. */
export const companyIdQuerySchema = companyIdObject.strict();

/** `{ companyId }` parsed from a multipart form body (multer puts non-file fields in `req.body`).
 * Deliberately non-strict: tolerant of future extra form fields uploaded alongside `file`. */
export const companyIdFormFieldSchema = companyIdObject;
