import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PROGRAM_ID = "3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s";

type VaultSnapshot = {
  vault: string;
  owner: string;
  agent: string;
  strategy: "Conservative" | "Balanced" | "Growth" | `Unknown(${number})`;
  lastRebalanceTs: string;
  allowedPrograms: string[];
  dataLength: number;
};

function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function readI64LE(data: Buffer, offset: number): bigint {
  return data.readBigInt64LE(offset);
}

function parseVault(pubkey: PublicKey, data: Buffer): VaultSnapshot | null {
  const expected = accountDiscriminator("Vault");
  if (data.length < 8 || !data.subarray(0, 8).equals(expected)) return null;

  let offset = 8;
  offset += 1; // bump

  const owner = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const agent = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;

  const strategyIdx = data.readUInt8(offset);
  offset += 1;
  const strategy =
    strategyIdx === 0
      ? "Conservative"
      : strategyIdx === 1
        ? "Balanced"
        : strategyIdx === 2
          ? "Growth"
          : (`Unknown(${strategyIdx})` as const);

  const lastRebalanceTs = readI64LE(data, offset);
  offset += 8;

  const count = data.readUInt32LE(offset);
  offset += 4;

  const allowedPrograms: string[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 32 > data.length) {
      throw new Error(`Vault ${pubkey.toBase58()} has truncated allowed_programs data`);
    }
    allowedPrograms.push(new PublicKey(data.subarray(offset, offset + 32)).toBase58());
    offset += 32;
  }

  return {
    vault: pubkey.toBase58(),
    owner: owner.toBase58(),
    agent: agent.toBase58(),
    strategy,
    lastRebalanceTs: lastRebalanceTs.toString(),
    allowedPrograms,
    dataLength: data.length,
  };
}

async function main() {
  const rpc = process.env.ANCHOR_PROVIDER_URL ?? "https://api.mainnet-beta.solana.com";
  const programId = new PublicKey(process.env.PROGRAM_ID ?? DEFAULT_PROGRAM_ID);
  const outPath =
    process.env.OUT ??
    join(__dirname, "..", "vaults-snapshot.json");

  const connection = new Connection(rpc, "confirmed");
  const accounts = await connection.getProgramAccounts(programId);
  const vaults = accounts
    .map((account) => parseVault(account.pubkey, account.account.data))
    .filter((v): v is VaultSnapshot => v !== null);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ rpc, programId: programId.toBase58(), vaults }, null, 2));

  console.log(`Found ${vaults.length} vault account(s) for ${programId.toBase58()}`);
  for (const vault of vaults) {
    console.log(
      [
        `vault=${vault.vault}`,
        `owner=${vault.owner}`,
        `agent=${vault.agent}`,
        `allowed=${vault.allowedPrograms.length}`,
        `dataLength=${vault.dataLength}`,
      ].join(" "),
    );
  }
  console.log(`Saved snapshot: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
