import { ORDER_STATUSES, type OrderStatus } from "../db/schema";

export const SORT_FIELDS = ["createdAt", "total"] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_SEARCH_LENGTH = 100;
// Keeps OFFSET = (page - 1) * pageSize far below Number.MAX_SAFE_INTEGER.
const MAX_PAGE = 1_000_000;

export interface OrdersQuery {
  page: number;
  pageSize: number;
  search: string | null;
  status: OrderStatus | null;
  sortBy: SortField;
  sortDir: SortDirection;
}

export interface QueryError {
  field: string;
  message: string;
}

export type ParseResult = { ok: true; query: OrdersQuery } | { ok: false; errors: QueryError[] };

const ALLOWED_KEYS = new Set(["page", "pageSize", "search", "status", "sortBy", "sortDir"]);

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

// Validates the raw query string of GET /api/orders. Everything is checked against
// allowlists, so nothing from the request ever reaches SQL except as a bound value.
// Unknown keys are rejected so a typo like "staus=paid" fails loudly instead of
// silently returning unfiltered results.
export function parseOrdersQuery(raw: Record<string, unknown>): ParseResult {
  const errors: QueryError[] = [];
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push({ field: key, message: "Unknown query parameter" });
    } else if (typeof value !== "string") {
      // e.g. ?status=paid&status=pending arrives as an array
      errors.push({ field: key, message: "Must be given once, as a single value" });
    } else {
      values[key] = value;
    }
  }

  const readInteger = (field: string, fallback: number, max: number): number => {
    const value = values[field];
    if (value === undefined) return fallback;
    if (!/^\d{1,9}$/.test(value) || Number(value) < 1 || Number(value) > max) {
      errors.push({ field, message: `Must be a whole number from 1 to ${max}` });
      return fallback;
    }
    return Number(value);
  };

  const page = readInteger("page", 1, MAX_PAGE);
  const pageSize = readInteger("pageSize", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const search = (values.search ?? "").trim();
  if (search.length > MAX_SEARCH_LENGTH) {
    errors.push({ field: "search", message: `Must be at most ${MAX_SEARCH_LENGTH} characters` });
  }

  // An empty value clears the filter (the UI sends nothing, but "?status=" is accepted too).
  const status = values.status ?? "";
  if (status !== "" && !isOneOf(ORDER_STATUSES, status)) {
    errors.push({ field: "status", message: `Must be one of: ${ORDER_STATUSES.join(", ")}` });
  }

  const sortBy = values.sortBy ?? "createdAt";
  if (!isOneOf(SORT_FIELDS, sortBy)) {
    errors.push({ field: "sortBy", message: `Must be one of: ${SORT_FIELDS.join(", ")}` });
  }

  const sortDir = values.sortDir ?? "desc";
  if (!isOneOf(SORT_DIRECTIONS, sortDir)) {
    errors.push({ field: "sortDir", message: `Must be one of: ${SORT_DIRECTIONS.join(", ")}` });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    query: {
      page,
      pageSize,
      search: search === "" ? null : search,
      status: status === "" ? null : (status as OrderStatus),
      sortBy: sortBy as SortField,
      sortDir: sortDir as SortDirection,
    },
  };
}
