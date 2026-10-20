import { useCallback, useEffect, useRef, useState } from "react";
import type { FetchOrders, OrdersPage, OrdersQuery } from "../api/orders";

export interface OrdersState {
  result: OrdersPage | null; // last successful page; kept (dimmed) while the next one loads
  loading: boolean;
  error: string | null;
}

// Loads one page of orders for `query` with "latest request wins" semantics.
//
// Two mechanisms, for two different jobs:
// 1. AbortController (resources): when the query changes or the component unmounts,
//    the previous fetch is aborted so the browser stops waiting for it.
// 2. Request id (correctness): every response, success or error, is applied only if
//    it belongs to the most recent request. Abort alone is not enough: if a response
//    has already arrived and its promise callback is queued, aborting does not stop that
//    callback from running; a fetch function may also simply ignore the signal. The id
//    check does not depend on either, so a stale page, error or loading=false can
//    never overwrite the state of the current request.
export function useOrders(query: OrdersQuery, fetchPage: FetchOrders) {
  const [state, setState] = useState<OrdersState>({ result: null, loading: true, error: null });
  const [reloadCount, setReloadCount] = useState(0);
  const latestRequestId = useRef(0);

  const { page, pageSize, search, status, sortBy, sortDir } = query;

  useEffect(() => {
    const requestId = ++latestRequestId.current;
    const isLatest = () => requestId === latestRequestId.current;
    const controller = new AbortController();

    setState((previous) => ({ ...previous, loading: true, error: null }));

    fetchPage({ page, pageSize, search, status, sortBy, sortDir }, controller.signal).then(
      (result) => {
        if (isLatest()) setState({ result, loading: false, error: null });
      },
      (error: unknown) => {
        // Also covers AbortError: a request is only aborted in the cleanup below,
        // which first marks it as no longer the latest.
        if (!isLatest()) return;
        // Drop the old rows: they belong to a different query than the one that failed.
        const message = error instanceof Error ? error.message : "Could not load orders";
        setState({ result: null, loading: false, error: message });
      },
    );

    // Runs when the query changes (before the next request starts) and on unmount.
    return () => {
      latestRequestId.current++; // this request is now obsolete, whatever happens to it next
      controller.abort();
    };
  }, [page, pageSize, search, status, sortBy, sortDir, reloadCount, fetchPage]);

  // Fetches the current query again (Retry after an error, refresh after creating an order).
  // It goes through the same effect, so the latest-request-wins rules still apply.
  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  return { ...state, reload };
}
