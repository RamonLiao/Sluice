import { describe, expect, it } from "vitest";
import { type CoinEntry, pickFundCoin } from "./FundPanel.js";

const coin = (id: string, balance: string): CoinEntry => ({ coinObjectId: id, balance });

describe("pickFundCoin", () => {
  it("throws when coins list is empty", () => {
    expect(() => pickFundCoin([], 1n)).toThrow("no coins found");
  });

  it("throws when only one coin exists (it would be the gas coin)", () => {
    expect(() => pickFundCoin([coin("0xA", "1000000000")], 1n)).toThrow(
      "no distinct fund coin",
    );
  });

  it("throws when all non-gas coins have insufficient balance", () => {
    const coins = [coin("0xA", "999"), coin("0xB", "500")];
    expect(() => pickFundCoin(coins, 1000n)).toThrow("no distinct fund coin");
  });

  it("selects the first non-gas coin with enough balance", () => {
    const coins = [coin("0xGAS", "5000"), coin("0xFUND", "3000"), coin("0xOTHER", "2000")];
    const picked = pickFundCoin(coins, 1000n);
    expect(picked.coinObjectId).toBe("0xFUND");
    // must not be the gas coin (index 0)
    expect(picked.coinObjectId).not.toBe("0xGAS");
  });

  it("picks the second candidate if the first non-gas coin is too small", () => {
    const coins = [coin("0xGAS", "9999"), coin("0xSMALL", "10"), coin("0xBIG", "5000")];
    const picked = pickFundCoin(coins, 1000n);
    expect(picked.coinObjectId).toBe("0xBIG");
  });

  it("never returns the gas coin even if it has the highest balance", () => {
    const coins = [coin("0xGAS", "9999999"), coin("0xFUND", "1")];
    const picked = pickFundCoin(coins, 1n);
    expect(picked.coinObjectId).toBe("0xFUND");
  });
});
