import { AddressLookupTableAccount, PublicKey } from "@solana/web3.js";

export function altsFromJupiter(raw: Record<string, string[]> | null): AddressLookupTableAccount[] {
  if (!raw) return [];
  return Object.entries(raw).map(([key, addresses]) => {
    return new AddressLookupTableAccount({
      key: new PublicKey(key),
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: addresses.map((a) => new PublicKey(a)),
      },
    });
  });
}

