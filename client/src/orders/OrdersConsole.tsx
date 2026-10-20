import { useEffect, useRef, useState } from "react";
import {
  createOrder as defaultCreateOrder,
  fetchOrders,
  MAX_SEARCH_LENGTH,
  ORDER_STATUSES,
  PAGE_SIZES,
  type CreateOrder,
  type FetchOrders,
  type OrderStatus,
  type OrdersQuery,
  type SortDirection,
  type SortField,
} from "../api/orders";
import { CreateOrderForm } from "./CreateOrderForm";
import { OrdersTable } from "./OrdersTable";
import { Pagination } from "./Pagination";
import { useOrders } from "./useOrders";

export const SEARCH_DEBOUNCE_MS = 300;

const DEFAULT_QUERY: OrdersQuery = {
  page: 1,
  pageSize: PAGE_SIZES[0],
  search: "",
  status: "",
  sortBy: "createdAt",
  sortDir: "desc",
};

type FilterChange = Partial<Omit<OrdersQuery, "page">>;

interface OrdersConsoleProps {
  // Injectable so tests can control timing and order of responses.
  fetchPage?: FetchOrders;
  createOrder?: CreateOrder;
}

export function OrdersConsole({ fetchPage = fetchOrders, createOrder = defaultCreateOrder }: OrdersConsoleProps) {
  // One state object: changing a filter and resetting the page happen in the same
  // update, so no request is ever sent for "new filter + old page".
  const [query, setQuery] = useState<OrdersQuery>(DEFAULT_QUERY);
  const [searchInput, setSearchInput] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [showCreate, setShowCreate] = useState(false);
  const { result, loading, error, reload } = useOrders(query, fetchPage);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  function changeFilters(change: FilterChange) {
    setQuery((current) => ({ ...current, ...change, page: 1 }));
  }

  // The input updates immediately; the query (and the request) only after the user
  // pauses typing, so typing "alice" sends one request instead of five.
  function handleSearchInput(value: string) {
    setSearchInput(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => changeFilters({ search: value.trim() }), SEARCH_DEBOUNCE_MS);
  }

  function clearFilters() {
    clearTimeout(searchTimer.current);
    setSearchInput("");
    setQuery((current) => ({ ...DEFAULT_QUERY, pageSize: current.pageSize }));
  }

  const hasFilters = searchInput !== "" || query.status !== "" || query.sortBy !== "createdAt" || query.sortDir !== "desc";

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <h1>Orders</h1>
          <p className="subtitle">Search, filter and sort all customer orders.</p>
        </div>
        {!showCreate && (
          <button type="button" onClick={() => setShowCreate(true)}>
            New order
          </button>
        )}
      </header>

      {showCreate && (
        <CreateOrderForm createOrder={createOrder} onCreated={reload} onClose={() => setShowCreate(false)} />
      )}

      <section className="toolbar" aria-label="Filters">
        <div className="field field-search">
          <label htmlFor="search">Search customer</label>
          <input
            id="search"
            type="search"
            placeholder="Name or email"
            maxLength={MAX_SEARCH_LENGTH}
            value={searchInput}
            onChange={(event) => handleSearchInput(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="status">Status</label>
          <select
            id="status"
            value={query.status}
            onChange={(event) => changeFilters({ status: event.target.value as OrderStatus | "" })}
          >
            <option value="">All statuses</option>
            {ORDER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status[0]!.toUpperCase() + status.slice(1)}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="sortBy">Sort by</label>
          <select
            id="sortBy"
            value={query.sortBy}
            onChange={(event) => changeFilters({ sortBy: event.target.value as SortField })}
          >
            <option value="createdAt">Created date</option>
            <option value="total">Total amount</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="sortDir">Direction</label>
          <select
            id="sortDir"
            value={query.sortDir}
            onChange={(event) => changeFilters({ sortDir: event.target.value as SortDirection })}
          >
            <option value="desc">{query.sortBy === "createdAt" ? "Newest first" : "Highest first"}</option>
            <option value="asc">{query.sortBy === "createdAt" ? "Oldest first" : "Lowest first"}</option>
          </select>
        </div>

        <button type="button" className="button-secondary" onClick={clearFilters} disabled={!hasFilters}>
          Clear filters
        </button>
      </section>

      <section className="results" aria-label="Orders">
        {error ? (
          <div className="state state-error" role="alert">
            <p>
              <strong>Could not load orders.</strong> {error}
            </p>
            <button type="button" onClick={reload}>
              Retry
            </button>
          </div>
        ) : result === null ? (
          <p className="state" role="status">
            Loading orders…
          </p>
        ) : (
          <>
            <OrdersTable orders={result.data} loading={loading} />
            {result.data.length === 0 && !loading && (
              <p className="state" role="status">
                No orders match these filters.
              </p>
            )}
            <Pagination
              page={query.page}
              pageSize={query.pageSize}
              total={result.pagination.total}
              totalPages={result.pagination.totalPages}
              loading={loading}
              onPageChange={(page) => setQuery((current) => ({ ...current, page }))}
              onPageSizeChange={(pageSize) => changeFilters({ pageSize })}
            />
          </>
        )}
      </section>
    </main>
  );
}
