/** Local Devnet sponsor service. The web process holds only a submit token, never this signer. */
import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { prepareRelay, verifyRelayReceipt, buildRelayInstruction, pinnedProgramHash, type RelayPolicy } from "./v2EvmRelayerCore.ts";
import { RelayJournal, type RelayJob } from "./v2EvmRelayJournal.ts";
import { EVM_DEVNET_GENESIS, EVM_DEVNET_PROGRAM, parseEvmOwnerIntent, verifyEvmIntentSignature, solanaSignatureBase58 } from "../../web/src/lib/v2EvmDevnet.ts";

export type RelayConfig = RelayPolicy & { rpcUrl: string; payer: string; keypairPath: string; journalPath: string;
  submitToken: string; adminToken: string; port: number; sendEnabled: boolean; automatic: boolean; automaticApproval?: string };
const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function protectedPath(path: string) {
  assert(isAbsolute(path) && resolve(path) !== codeRoot && !resolve(path).startsWith(codeRoot + sep), "signer/journal must be outside the checkout");
}
export function loadRelayConfig(path: string): RelayConfig {
  assert.equal(process.platform, "linux", "Use the protected Linux/WSL operator runtime");
  protectedPath(path); assert.equal(statSync(path).mode & 0o077, 0, "configuration must have mode 0600");
  assert.equal(statSync(dirname(path)).mode & 0o077, 0, "configuration directory must be private");
  const c = JSON.parse(readFileSync(path, "utf8")) as RelayConfig;
  assert(c && typeof c === "object" && !Array.isArray(c));
  assert(new URL(c.rpcUrl).protocol === "https:"); assert(/^[0-9a-f]{64}$/.test(c.expectedElfSha256)); assert(Number.isSafeInteger(c.expectedElfBytes) && c.expectedElfBytes > 0 && c.expectedElfBytes <= 10485760);
  assert(Array.isArray(c.allowedOwners) && c.allowedOwners.length > 0 && c.allowedOwners.every(x => /^0x[0-9a-fA-F]{40}$/.test(x)));
  for (const k of ["maxFeeLamports", "maxRentLamports", "maxDailyLamports", "maxHourlyTransactions", "minBalanceLamports", "port"] as const) assert(Number.isSafeInteger(c[k]) && c[k] > 0);
  assert(c.port > 1024 && c.port < 65536 && c.maxFeeLamports <= 100000 && c.maxRentLamports <= 10000000 && c.maxDailyLamports <= 50000000 && c.maxHourlyTransactions <= 60);
  assert(typeof c.sendEnabled === "boolean" && typeof c.automatic === "boolean" && typeof c.allowLifecycle === "boolean");
  if (c.automatic) assert(c.sendEnabled && c.automaticApproval === "DEVNET_OWNER_SIGNED_INTENTS_WITH_LIMITS", "automatic relay requires the bounded Devnet execution policy");
  for (const token of [c.submitToken, c.adminToken]) assert(typeof token === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(token));
  assert.notEqual(c.submitToken, c.adminToken, "submit token must not authorize sends");
  protectedPath(c.keypairPath); protectedPath(c.journalPath); assert.equal(statSync(c.keypairPath).mode & 0o077, 0, "signer must have mode 0600");
  assert.notEqual(c.payer, "8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A", "operator upgrade signer forbidden in service");
  new PublicKey(c.payer); return c;
}
export function publicJob(job: RelayJob) {
  return { id: job.id, state: job.state, plan: job.plan, planHash: createHash("sha256").update(JSON.stringify(job.plan)).digest("hex"),
    ...(job.signature ? { signature: job.signature } : {}), ...(job.slot ? { slot: job.slot } : {}),
    ...(job.actualCostLamports !== undefined ? { actualCostLamports: job.actualCostLamports } : {}), ...(job.failure ? { failure: job.failure } : {}) };
}
export class RelayerWorker {
  private lane: Promise<unknown> = Promise.resolve();
  constructor(readonly config: RelayConfig, readonly connection: Connection, readonly signer: Keypair, readonly journal: RelayJournal) {
    assert.equal(signer.publicKey.toBase58(), config.payer);
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lane.then(fn, fn); this.lane = run.catch(() => undefined); return run;
  }
  async enqueue(input: Record<string, unknown>) {
    const intent = parseEvmOwnerIntent(input), digest = await verifyEvmIntentSignature(intent);
    const old = this.journal.get(digest); if (old) return publicJob(old);
    assert(this.journal.all().filter(x => x.state === "quoted" && Number(x.intent.deadline) * 1000 > Date.now()).length < 32, "quote queue full");
    const prepared = await prepareRelay(this.connection, input, this.signer.publicKey, this.config);
    this.journal.assertBudget(prepared.plan.costLamports, this.config);
    const job: RelayJob = { id: digest, safe: intent.safe, owner: intent.owner, nonce: intent.nonce, state: "quoted", createdAt: Date.now(),
      intent: prepared.intent as unknown as Record<string, unknown>, plan: prepared.plan as unknown as Record<string, unknown>, costLamports: prepared.plan.costLamports };
    this.journal.record(job);
    if (this.config.automatic) return this.approve(digest, publicJob(job).planHash);
    return publicJob(job);
  }
  async approve(id: string, approvedPlanHash: string) {
    assert(this.config.sendEnabled, "sending disabled by operator configuration");
    const job = this.journal.get(id); assert(job, "job missing");
    if (job.state !== "quoted") return publicJob(job);
    assert.equal(publicJob(job).planHash, approvedPlanHash, "reviewed plan changed");
    const p = await prepareRelay(this.connection, job.intent, this.signer.publicKey, this.config);
    assert.equal(p.digest, id); assert(p.plan.costLamports <= job.costLamports, "cost increased; new review required");
    this.journal.assertBudget(job.costLamports, this.config);
    p.transaction.sign(this.signer);
    const wire = p.transaction.serialize(); // Signature validation occurs before any durable reservation or send.
    Object.assign(job, { state: "prepared", signature: solanaSignatureBase58(p.transaction.signature!), wireBase64: wire.toString("base64"), lastValidBlockHeight: p.block.lastValidBlockHeight });
    this.journal.record(job); return this.transmit(job);
  }
  private async transmit(job: RelayJob) {
    assert(this.config.sendEnabled && job.signature && job.wireBase64);
    assert(BigInt(job.intent.deadline as string) > BigInt(Math.floor(Date.now() / 1000)), "intent expired; inspect prepared transaction before resolving");
    try {
      const signature = await this.connection.sendRawTransaction(Buffer.from(job.wireBase64, "base64"), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 2 });
      assert.equal(signature, job.signature); job.state = "submitted"; this.journal.record(job);
    } catch {
      job.state = "unknown"; job.failure = "submission uncertain; inspect the recorded signature; no new transaction is signed"; this.journal.record(job); return publicJob(job);
    }
    // The HTTP request returns promptly; finalized receipt is reconciled by the worker timer.
    return publicJob(job);
  }
  async reconcile() {
    for (const job of this.journal.all().filter(x => ["prepared", "submitted", "unknown"].includes(x.state))) {
      assert(job.signature && job.wireBase64);
      const tx = Transaction.from(Buffer.from(job.wireBase64, "base64")); assert(tx.verifySignatures() && tx.feePayer?.equals(this.signer.publicKey));
      assert.equal(solanaSignatureBase58(tx.signature!), job.signature);
      const intent = parseEvmOwnerIntent(job.intent);
      assert.equal(await verifyEvmIntentSignature(intent), job.id);
      const expected = new Transaction({ feePayer: this.signer.publicKey, recentBlockhash: tx.recentBlockhash }).add(await buildRelayInstruction(this.connection, intent, this.signer.publicKey));
      assert(expected.serializeMessage().equals(tx.serializeMessage()), "saved wire differs from the approved typed intent");
      const status = (await this.connection.getSignatureStatuses([job.signature], { searchTransactionHistory: true })).value[0];
      if (status?.confirmationStatus === "finalized") {
        const receipt = await verifyRelayReceipt(this.connection, job.signature, parseEvmOwnerIntent(job.intent));
        assert(receipt.costLamports <= job.costLamports, "receipt exceeded reserved cost");
        Object.assign(job, { state: receipt.success ? "finalized" : "failed", actualCostLamports: receipt.costLamports, slot: receipt.slot, failure: receipt.success ? undefined : "transaction failed on-chain" }); this.journal.record(job);
      } else if (!status && job.state === "prepared" && this.config.sendEnabled && Number(job.intent.deadline) > Date.now() / 1000
        && (await this.connection.getBlockHeight("finalized")) <= job.lastValidBlockHeight!) {
        await this.transmit(job); // Same signed bytes only; never a fresh blockhash/signature on recovery.
      } else if (!status && job.state !== "unknown" && (await this.connection.getBlockHeight("finalized")) > job.lastValidBlockHeight!) {
        job.state = "unknown"; job.failure = "expired blockhash with unresolved receipt; reserve retained for manual investigation"; this.journal.record(job);
      }
    }
  }
}
function authorized(request: IncomingMessage, token: string) {
  const header = request.headers.authorization || "";
  return timingSafeEqual(createHash("sha256").update(header).digest(), createHash("sha256").update("Bearer " + token).digest());
}
async function body(request: IncomingMessage) {
  assert(request.headers["content-type"]?.startsWith("application/json"));
  let size = 0, chunks: Buffer[] = [];
  for await (const chunk of request) { const b = Buffer.from(chunk); size += b.length; assert(size <= 4096, "request too large"); chunks.push(b); }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")); assert(input && typeof input === "object" && !Array.isArray(input)); return input as Record<string, unknown>;
}
export async function startRelayer(config: RelayConfig) {
  const connection = new Connection(config.rpcUrl, "confirmed");
  assert.equal(await connection.getGenesisHash(), EVM_DEVNET_GENESIS);
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), [pdAddress] = PublicKey.findProgramAddressSync([EVM_DEVNET_PROGRAM.toBuffer()], loader);
  const pd = await connection.getAccountInfo(pdAddress, "finalized"); assert(pd && pd.owner.equals(loader));
  pinnedProgramHash(pd.data, config);
  if (pd.data[12] === 1) assert.notEqual(new PublicKey(pd.data.subarray(13,45)).toBase58(), config.payer);
  const raw = Uint8Array.from(JSON.parse(readFileSync(config.keypairPath, "utf8"))), signer = Keypair.fromSecretKey(Uint8Array.from(raw)); raw.fill(0);
  const journal = new RelayJournal(config.journalPath), worker = new RelayerWorker(config, connection, signer, journal);
  try { await worker.exclusive(() => worker.reconcile()); }
  catch (error) { journal.close(); signer.secretKey.fill(0); throw error; }
  let shuttingDown = false; const errors: Record<string, number> = {};
  const timer = setInterval(() => { if (!shuttingDown) void worker.exclusive(() => worker.reconcile()).catch(() => console.error(JSON.stringify({ event: "reconciliation_pending", signatures: journal.all().filter(x => ["prepared","submitted","unknown"].includes(x.state)).map(x => x.signature) }))); }, 5000);
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/health" && request.method === "GET") { response.end(JSON.stringify({ cluster: "devnet", payer: config.payer, sendEnabled: config.sendEnabled, automatic: config.automatic, allowLifecycle: config.allowLifecycle })); return; }
      const approve = /^\/jobs\/0x[0-9a-f]{64}\/approve$/.test(url.pathname);
      if (!authorized(request, approve ? config.adminToken : config.submitToken)) { response.statusCode = 401; response.end(JSON.stringify({ error: "unauthorized" })); return; }
      if (url.pathname === "/jobs" && request.method === "POST") {
        const minute = Math.floor(Date.now()/60000).toString(); errors[minute] = (errors[minute] || 0) + 1;
        for (const key of Object.keys(errors)) if (key !== minute) delete errors[key];
        assert(errors[minute] <= 30, "request rate limit reached");
        const input = await body(request), result = await worker.exclusive(() => worker.enqueue(input)); response.statusCode = 202; response.end(JSON.stringify(result)); return;
      }
      if (approve && request.method === "POST") { const input = await body(request); assert(typeof input.planHash === "string"); const result = await worker.exclusive(() => worker.approve(url.pathname.split("/")[2], input.planHash as string)); response.end(JSON.stringify(result)); return; }
      if (/^\/jobs\/0x[0-9a-f]{64}$/.test(url.pathname) && request.method === "GET") { const job = journal.get(url.pathname.split("/")[2]); response.statusCode = job ? 200 : 404; response.end(JSON.stringify(job ? publicJob(job) : { error: "job missing" })); return; }
      response.statusCode = 404; response.end(JSON.stringify({ error: "route missing" }));
    } catch (error) {
      response.statusCode = 409;
      // Return only our own assertion/input errors. RPC transport exceptions can include credential URLs.
      const message = error instanceof assert.AssertionError ? error.message : "request unavailable or invalid";
      response.end(JSON.stringify({ error: message.slice(0,180) }));
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", resolve); }); }
  catch (error) { clearInterval(timer); journal.close(); signer.secretKey.fill(0); throw error; }
  console.log(JSON.stringify({ event: "relayer_started", cluster: "devnet", payer: config.payer, port: config.port, sendEnabled: config.sendEnabled, automatic: config.automatic, maxDailyLamports: config.maxDailyLamports }));
  const stop = () => { shuttingDown = true; clearInterval(timer); server.close(() => { void worker.exclusive(async () => { journal.close(); signer.secretKey.fill(0); process.exit(0); }); }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return { server, worker, journal };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2];
  if (!configPath) throw Error("Use v2EvmRelayerService.ts <protected-config.json>");
  startRelayer(loadRelayConfig(configPath)).catch(() => { console.error("Relayer start failed; inspect protected configuration and journal locally"); process.exitCode = 1; });
}
