import type { Db } from "../db/connection";
import type { OrderStatus } from "../db/schema";
import type { OrdersQuery, SortDirection, SortField } from "./query";

export interface OrderSummary {
  id: number;
  customerName: string;
  customerEmail: string;
  status: OrderStatus;
  totalCents: number;
  createdAt: string;
}

export interface OrdersPage {
  data: OrderSummary[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// Allowlist maps: the only column names and keywords that can appear in ORDER BY.
// Request values are used as lookup keys here, never pasted into SQL.
const SORT_COLUMNS: Record<SortField, string> = { createdAt: "created_at", total: "total_cents" };
const SORT_KEYWORDS: Record<SortDirection, string> = { asc: "ASC", desc: "DESC" };

const LIST_COLUMNS = `id, customer_name AS customerName, customer_email AS customerEmail,
  status, total_cents AS totalCents, created_at AS createdAt`;

// In LIKE, "%" and "_" are wildcards. Prefix them (and the escape character itself)
// with a backslash so a search for "50%" or "a_b" matches those characters literally.
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface OrdersSql {
  countSql: string;
  pageSql: string;
  params: Record<string, string | number>;
}

// Builds both statements for one query. Exported so the benchmark measures exactly
// the SQL the API runs. All user input goes into `params` (bound values).
export function buildOrdersSql(query: OrdersQuery): OrdersSql {
  const conditions: string[] = [];
  const params: Record<string, string | number> = {
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };

  if (query.status) {
    conditions.push("status = @status");
    params.status = query.status;
  }
  if (query.search) {
    // Substring match, case-insensitive for ASCII letters only (SQLite's default LIKE).
    // A leading "%" means no B-tree index can be used for this condition: it is a scan.
    conditions.push("(customer_name LIKE @pattern ESCAPE '\\' OR customer_email LIKE @pattern ESCAPE '\\')");
    params.pattern = `%${escapeLike(query.search)}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const direction = SORT_KEYWORDS[query.sortDir];
  // id breaks ties so rows with equal dates/amounts keep a fixed order across pages.
  const orderBy = `ORDER BY ${SORT_COLUMNS[query.sortBy]} ${direction}, id ${direction}`;

  return {
    countSql: `SELECT COUNT(*) FROM orders ${where}`,
    pageSql: `SELECT ${LIST_COLUMNS} FROM orders ${where} ${orderBy} LIMIT @limit OFFSET @offset`,
    params,
  };
}

// better-sqlite3 rejects named parameters that a statement does not use,
// and the count statement has no LIMIT/OFFSET.
function withoutPaging(params: OrdersSql["params"]): OrdersSql["params"] {
  const { limit: _limit, offset: _offset, ...rest } = params;
  return rest;
}

export function listOrders(db: Db, query: OrdersQuery): OrdersPage {
  const { countSql, pageSql, params } = buildOrdersSql(query);

  // One read transaction so the total and the page come from the same snapshot,
  // even if an order is inserted between the two statements.
  const read = db.transaction(() => ({
    total: db.prepare(countSql).pluck().get(withoutPaging(params)) as number,
    data: db.prepare(pageSql).all(params) as OrderSummary[],
  }));
  const { total, data } = read();

  return {
    data,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    },
  };
}
