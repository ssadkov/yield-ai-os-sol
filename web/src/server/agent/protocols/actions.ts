export const LENDING_PROTOCOL_ACTIONS = [
  "initPosition",
  "depositCollateral",
  "borrow",
  "repay",
  "withdrawCollateral",
] as const;

export type LendingProtocolAction = (typeof LENDING_PROTOCOL_ACTIONS)[number];

export function isLendingProtocolAction(value: string): value is LendingProtocolAction {
  return (LENDING_PROTOCOL_ACTIONS as readonly string[]).includes(value);
}
