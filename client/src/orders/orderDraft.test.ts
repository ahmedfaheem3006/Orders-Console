import { describe, expect, it } from "vitest";
import { draftTotalCents, parsePriceToCents, validateDraft, type OrderDraft } from "./orderDraft";

describe("parsePriceToCents", () => {
  it("converts decimal text to integer cents without floating-point error", () => {
    expect(0.29 * 100).not.toBe(29); // the bug this function avoids
    expect(parsePriceToCents("0.29")).toBe(29);
    expect(parsePriceToCents("24.99")).toBe(2_499);
    expect(parsePriceToCents("24.9")).toBe(2_490);
    expect(parsePriceToCents("24")).toBe(2_400);
    expect(parsePriceToCents(" 1.05 ")).toBe(105);
    expect(parsePriceToCents("100000.00")).toBe(10_000_000);
  });

  it("rejects anything that is not a positive amount with at most 2 decimals", () => {
    for (const text of ["", "0", "0.00", "-1", "24.999", "1e3", "abc", "1,000", "100000.01", ".5", "5."]) {
      expect(parsePriceToCents(text), text).toBeNull();
    }
  });
});

describe("validateDraft", () => {
  const valid: OrderDraft = {
    customerName: "  Sara Ali ",
    customerEmail: "sara@example.com",
    items: [
      { key: 1, productName: "Mouse", quantity: "2", unitPrice: "24.99" },
      { key: 2, productName: "Cable", quantity: "1", unitPrice: "9.99" },
    ],
  };

  it("builds a trimmed payload in integer cents", () => {
    expect(validateDraft(valid)).toEqual({
      errors: {},
      payload: {
        customerName: "Sara Ali",
        customerEmail: "sara@example.com",
        items: [
          { productName: "Mouse", quantity: 2, unitPriceCents: 2_499 },
          { productName: "Cable", quantity: 1, unitPriceCents: 999 },
        ],
      },
    });
    expect(draftTotalCents(valid)).toBe(5_997);
  });

  it("reports errors with the same field paths the server uses", () => {
    const { payload, errors } = validateDraft({
      customerName: " ",
      customerEmail: "nope",
      items: [{ key: 1, productName: "", quantity: "1.5", unitPrice: "0" }],
    });
    expect(payload).toBeNull();
    expect(Object.keys(errors).sort()).toEqual([
      "customerEmail",
      "customerName",
      "items[0].productName",
      "items[0].quantity",
      "items[0].unitPriceCents",
    ]);
  });
});
