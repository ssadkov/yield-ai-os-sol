/** Fixed user-selected Devnet governance policy. No signing or authority transfer. */
import assert from "node:assert/strict";
import * as squads from "@sqds/multisig";
import { PublicKey } from "@solana/web3.js";

export const SQUADS_PROGRAM = squads.PROGRAM_ID;
export const GOVERNANCE_MEMBERS = [
  "5m14KnDtidRfBXqETVRCWbNQJNPy8sxxhviaTqkf51XQ",
  "EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2",
  "4HfKpcmwZoF2u1ZVmHBJ6496y8VjNZGTHpJQTLQZ2E4B",
];
export const GOVERNANCE_TIMELOCK = 3600;
export const RELAYER = new PublicKey("GhK2bfKSsFgVrm6RbgHZkMzQ34pvYh5tGjfda3UchY1s");
export const OPERATOR = new PublicKey("8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A");
export function validateGovernance(account: { owner: PublicKey; executable: boolean; data: Buffer }, address: PublicKey) {
  assert(account.owner.equals(SQUADS_PROGRAM) && !account.executable, "unexpected multisig owner/state");
  assert(account.data.subarray(0, 8).equals(Buffer.from(squads.accounts.multisigDiscriminator)), "wrong multisig discriminator");
  const [config] = squads.accounts.Multisig.deserialize(account.data);
  const [derived, bump] = squads.getMultisigPda({ createKey: config.createKey });
  assert(address.equals(derived) && config.bump === bump, "multisig derivation mismatch");
  assert(config.configAuthority.equals(PublicKey.default), "external config authority can override governance");
  assert.equal(config.threshold, 2, "expected threshold 2");
  assert.equal(config.timeLock, GOVERNANCE_TIMELOCK, "expected one-hour Devnet timelock");
  assert.equal(config.members.length, 3, "expected three members");
  assert.equal(new Set(config.members.map(m => m.key.toBase58())).size, 3, "duplicate members");
  assert.deepEqual(config.members.map(m => m.key.toBase58()).sort(), [...GOVERNANCE_MEMBERS].sort(), "unexpected members");
  assert(config.members.every(m => !m.key.equals(RELAYER) && m.permissions.mask === 7), "unexpected member permissions or relayer membership");
  const [vault] = squads.getVaultPda({ multisigPda: address, index: 0 });
  assert(!vault.equals(RELAYER) && !vault.equals(OPERATOR));
  return { config, vault };
}
