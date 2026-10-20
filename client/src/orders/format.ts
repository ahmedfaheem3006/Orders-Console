// Display-only formatting. Amounts stay integer cents everywhere else.
// Assumption: all orders are in one currency (SAR); the data model has no currency column.
const amountFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "SAR" });
const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

export function formatAmount(cents: number): string {
  return amountFormat.format(cents / 100);
}

// Shown in the viewer's local time zone; the API returns UTC ISO strings.
export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}
