import { MobileApiError, solanaOwner } from "./mobileSafe.ts";

export function protocolRequest(body: unknown, keys: string[]) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MobileApiError("INVALID_REQUEST", "Expected a JSON object");
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !["owner", "cluster", ...keys].includes(key))) throw new MobileApiError("INVALID_REQUEST", "Unexpected protocol-plan field");
  const owner = solanaOwner(value.owner);
  return { value, owner };
}
export function selectPositionAmount(value: Record<string, unknown>, available: bigint) {
  if ((value.shares === undefined) === (value.percent === undefined)) throw new MobileApiError("INVALID_REQUEST", "Provide either shares (raw PT integer or all) or percent");
  let amount: bigint;
  if (value.shares !== undefined) {
    if (value.shares === "all") amount = available;
    else if (typeof value.shares === "string" && /^[1-9]\d{0,19}$/.test(value.shares)) amount = BigInt(value.shares);
    else throw new MobileApiError("INVALID_REQUEST", "Invalid raw PT amount");
  } else {
    if (typeof value.percent !== "string" || !/^(?:100(?:\.0{1,2})?|(?:0|[1-9]\d?)(?:\.\d{1,2})?)$/.test(value.percent)) throw new MobileApiError("INVALID_REQUEST", "percent must be a string in 0..100, up to two decimals");
    const [whole, decimals = ""] = value.percent.split(".");
    const bps = BigInt(whole) * BigInt(100) + BigInt(decimals.padEnd(2, "0"));
    if (bps === BigInt(0)) throw new MobileApiError("INVALID_REQUEST", "percent must be positive");
    amount = available * bps / BigInt(10000);
  }
  if (amount > available || amount > (BigInt(1) << BigInt(64)) - BigInt(1)) throw new MobileApiError("INSUFFICIENT_PT", "Amount exceeds the tracked position", 422);
  if (!amount && value.shares !== "all") throw new MobileApiError("INVALID_REQUEST", "Amount rounds to zero");
  return amount;
}
