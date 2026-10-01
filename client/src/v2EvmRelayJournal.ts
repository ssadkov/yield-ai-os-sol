import assert from "node:assert/strict";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type RelayState = "quoted" | "prepared" | "submitted" | "unknown" | "finalized" | "failed";
export type RelayJob = {
  id: string; safe: string; owner: string; nonce: string; state: RelayState; createdAt: number;
  intent: Record<string, unknown>; plan: Record<string, unknown>; costLamports: number;
  signature?: string; wireBase64?: string; lastValidBlockHeight?: number;
  actualCostLamports?: number; slot?: number; failure?: string;
};
const pending = new Set<RelayState>(["prepared", "submitted", "unknown"]);
const transitions: Record<RelayState, RelayState[]> = {
  quoted: ["prepared", "failed"], prepared: ["submitted", "unknown", "finalized", "failed"],
  submitted: ["unknown", "finalized", "failed"], unknown: ["submitted", "finalized", "failed"], finalized: [], failed: [],
};
/** One local writer, fsync before RPC send. Corrupt/truncated histories stop the service. */
export class RelayJournal {
  private jobs = new Map<string, RelayJob>();
  private lock: string;
  private poisoned = false;
  constructor(private path: string, private acquireLock = true) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.lock = path + ".lock";
    if (acquireLock) { const fd = openSync(this.lock, "wx", 0o600); try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd); } finally { closeSync(fd); } }
    try {
      if (existsSync(path)) {
        const data = readFileSync(path, "utf8");
        assert(data === "" || data.endsWith("\n"), "truncated journal: manual recovery required");
        for (const line of data.split("\n").filter(Boolean)) this.apply(JSON.parse(line));
      }
    } catch (error) { if (acquireLock) unlinkSync(this.lock); throw error; }
  }
  private apply(job: RelayJob) {
    assert(/^0x[0-9a-f]{64}$/.test(job.id), "invalid job digest");
    assert(Number.isSafeInteger(job.createdAt) && job.createdAt >= 0 && Number.isSafeInteger(job.costLamports) && job.costLamports >= 0);
    assert(Object.hasOwn(transitions, job.state));
    const old = this.jobs.get(job.id);
    if (old) {
      assert(transitions[old.state].includes(job.state), "invalid journal transition");
      assert.equal(job.safe, old.safe); assert.equal(job.owner, old.owner); assert.equal(job.nonce, old.nonce); assert.equal(job.createdAt, old.createdAt);
      assert.equal(JSON.stringify(job.intent), JSON.stringify(old.intent));
      if (old.signature) { assert.equal(job.signature, old.signature); assert.equal(job.wireBase64, old.wireBase64); }
    } else assert.equal(job.state, "quoted", "new job must start quoted");
    if (pending.has(job.state)) {
      assert(job.signature && /^[A-Za-z0-9]+$/.test(job.signature)); assert(job.wireBase64 && job.wireBase64.length <= 6000);
      assert(Number.isSafeInteger(job.lastValidBlockHeight));
      assert(![...this.jobs.values()].some(x => x.id !== job.id && x.safe === job.safe && x.nonce === job.nonce && pending.has(x.state)), "another transaction reserved this Safe nonce");
    }
    if (job.actualCostLamports !== undefined) assert(Number.isSafeInteger(job.actualCostLamports) && job.actualCostLamports >= 0 && job.actualCostLamports <= job.costLamports);
    this.jobs.set(job.id, structuredClone(job));
  }
  get(id: string) { const job = this.jobs.get(id); return job && structuredClone(job); }
  all() { return [...this.jobs.values()].map(x => structuredClone(x)); }
  record(job: RelayJob) {
    assert(!this.poisoned, "journal write failed earlier; service stopped for manual recovery");
    // Validate on a separate view before writing the durable event.
    const previous = this.jobs; this.jobs = new Map(previous);
    try { this.apply(job); } catch (error) { this.jobs = previous; throw error; }
    let fd: number | undefined;
    try {
      fd = openSync(this.path, "a", 0o600); appendFileSync(fd, JSON.stringify(job) + "\n"); fsyncSync(fd);
      const directory = openSync(dirname(this.path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    catch (error) { this.jobs = previous; this.poisoned = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  assertBudget(cost: number, policy: { maxDailyLamports: number; maxHourlyTransactions: number }, now = Date.now()) {
    assert(Number.isSafeInteger(cost) && cost >= 0);
    const spent = this.all().filter(x => x.state !== "quoted" && (pending.has(x.state) || x.createdAt > now - 86400000));
    const reserved = spent.reduce((sum, x) => sum + (x.actualCostLamports ?? x.costLamports), 0);
    assert(reserved + cost <= policy.maxDailyLamports, "daily sponsor budget exhausted");
    assert(spent.filter(x => pending.has(x.state) || x.createdAt > now - 3600000).length < policy.maxHourlyTransactions, "hourly submission limit exhausted");
  }
  close() { if (this.acquireLock && existsSync(this.lock)) unlinkSync(this.lock); }
}
