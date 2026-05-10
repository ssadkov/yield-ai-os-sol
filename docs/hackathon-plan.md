# Yield AI — Hackathon Plan (Frontier + KZ + S1lkPay)

15 working hours, solo, video self-recorded.
Code freeze 6h before submission. Submit minimum 2h before deadline.

---

## Session 1 — 3h · Stocks-Earn flagship polish

Loop already works on mainnet. Goal: make it the demo centerpiece.

- Single screen `/earn/stocks` (or modal) with three states: `Setup → Active → Unwinding`.
- Big live numbers: **Net APY**, **Health factor**, **Liquidation price**, **Earned USDC (live)**.
- One CTA: `Activate Earn loop`. In active state: `Unwind to SPYx`.
- Caption under CTA: "Agent auto-deleverages if health < X. Your SPYx never leaves your vault."
- **Solscan links on every leg** (lend / borrow / earn) — main visual proof in the video.

**Checkpoint:** can record screen, activate loop, see Net APY > 0, trigger Unwind. If Unwind doesn't fit in time — show only activation in video.

---

## Session 2 — 3h · Earn-idle USDC + Security panel

### Earn-idle (1.5–2h)
- `Park USDC` button next to vault balance.
- Picks best APY between Jupiter Lend / Kamino from existing offchain data.
- Shows: `Earning X% APY · Park more / Withdraw`.
- One screen, no settings.

### Security panel (1–1.5h)
On main vault page:
- Vault PDA (Solscan link)
- Owner (you) · Agent pubkey
- **Whitelisted programs** with human names: "Jupiter Router", "Kamino Lend", "Jupiter Lend", "SPL Token". Each → Solscan link.
- Bullet rows:
  - Agent cannot withdraw
  - Owner-only withdraw enforced on-chain
  - Allowlist editable only by owner

**Checkpoint:** this panel is the "Trust layer" frame in the video.

---

## Session 3 — 3h · Demo content prep (no code)

**Do not skip — saves time during recording.**

- Mainnet vault ready with full allowlist deployed (Jupiter Router, Jupiter Lend, Kamino Lend). Top up if missing.
- Same wallet: enough USDC for Earn-idle demo + SPYx for Stocks-Earn demo.
- Save **3–4 mainnet tx hashes** in advance: deposit, lend, borrow, park-idle. Pre-open Solscan tabs for b-roll.
- Write full video script as text. Read it aloud once — find rough spots.
- One screenshot of mobile prototype (no video).

**Checkpoint:** ready to record without interruptions.

---

## Session 4 — 4h · Video (record + edit)

One sitting, no breaks (voice consistency).

Target: 2:30 max.

```
0:00–0:20  Vision         (idle capital + custody trade-off, voice over UI)
0:20–0:40  Trust layer    (Security panel, slow zoom on allowlist)
0:40–1:30  Stocks-Earn    (mainnet live demo, Solscan tx visible)
1:30–1:55  Earn-idle USDC (one click)
1:55–2:15  Open agent layer (strategies.ts frame, "anyone can build on this")
2:15–2:30  Roadmap + close (mobile screenshot 2s, links)
```

Recording:
- Single pass screen + voice. Mistakes get cut, don't restart.
- Separate voice track if comfortable — otherwise inline is fine.
- First sentence must contain **"Solana mainnet"** — keyword.

Editing:
- Cut hard. No music longer than 30s, no intro card longer than 2s.

**Backup:** if recording goes badly — slideshow with voiceover + one Stocks-Earn screencast inserted. Boring on time beats polished late.

---

## Session 5 — 2h · Submission + polish

- Fill Colosseum form + two side-tracks (KZ + S1lkPay). **Different positioning text per track** (below).
- Update README:
  - "What's new in this submission" paragraph
  - Video link
  - Solscan links to vault + programs
  - Demo tx hashes
- Smoke test on clean incognito: nothing crashes, wallet connects, demo flow works.

**Checkpoint:** submitted ≥ 2h before deadline.

---

## Buffer

Plan above is 15h flat. If something slips, cut in this order:
1. Earn-idle (if Stocks-Earn looks strong enough alone)
2. Security panel (compress to 5 bullets on main page)

---

## Positioning copy

### Frontier (main track)
> Yield AI is an agent-safe execution layer for Solana. A PDA vault with a program allowlist lets AI agents put user capital to work without ever holding the keys. Live on mainnet today, with a working consumer flow that earns USDC yield on stock positions without selling them.

### Superteam Kazakhstan
> Yield AI — потребительский продукт на Solana, который автоматически работает с капиталом пользователя: паркует USDC в лучший lending pool и зарабатывает доходность на токенизированных акциях, не продавая их. Кошельковая безопасность сохранена on-chain через PDA-vault.

### S1lkPay (no idle capital)
> Yield AI's Earn mode turns idle USDC balances into productive capital with one click — agent automatically routes to the best lending pool (Jupiter Lend / Kamino), and unwinds back to USDC instantly on withdraw. Custody stays in user's PDA vault throughout.

---

## Hard rules for the next 15 hours

- **Do not touch the Anchor program.** At all.
- **Do not add new tokens/programs to the allowlist** during demo window (only if required by an already-planned feature).
- **Git commit every 3 hours** with a clear message — be able to roll back.
- **Code freeze 6h before deadline.** Only video + forms after.
- **If anything is broken for > 30 min — roll back and move on.** Can't fix in deadline; can route around.

---

## Cuts (already decided)

- Custom strategy sliders → mention in video as "open framework" with a frame of `strategies.ts`. Zero code.
- New chat tool-calls → only if buffer remains.
- Mobile demo → 2 seconds of screenshot in video. No code.
