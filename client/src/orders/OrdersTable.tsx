import type { OrderSummary } from "../api/orders";
import { formatAmount, formatDate } from "./format";

interface OrdersTableProps {
  orders: OrderSummary[];
  loading: boolean;
}

export function OrdersTable({ orders, loading }: OrdersTableProps) {
  return (
    // The wrapper scrolls horizontally on narrow screens instead of squashing columns.
    <div className={loading ? "table-wrap is-loading" : "table-wrap"}>
      <table aria-busy={loading}>
        <caption className="visually-hidden">Orders</caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Customer</th>
            <th scope="col">Email</th>
            <th scope="col">Status</th>
            <th scope="col" className="numeric">
              Total
            </th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id}>
              <td className="mono">#{order.id}</td>
              <td>{order.customerName}</td>
              <td className="muted">{order.customerEmail}</td>
              <td>
                <span className={`badge badge-${order.status}`}>{order.status}</span>
              </td>
              <td className="numeric">{formatAmount(order.totalCents)}</td>
              <td className="nowrap">
                <time dateTime={order.createdAt}>{formatDate(order.createdAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
