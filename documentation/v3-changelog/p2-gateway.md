## Gateway (P2) — the assistant in your pocket

- New `gateway-engine/` exposed as `runtime.gateway` (`notify()`, `status()`, `bind(runtime)`): the owner commands AStack from WhatsApp and Telegram, receives reports, and approves irreversible steps by message.
- Channels: `whatsapp-wapi` (self-hosted wapi REST, polling), `whatsapp-bridge` (own Baileys linked-device bridge installed on demand into `.astack/gateway/bridge/` by `astack gateway whatsapp setup`, paired with `astack gateway whatsapp pair`), `whatsapp-cloud` (Meta Cloud API with signed webhook and verify-token handshake), `telegram` (Bot API long polling) and a `cli` loopback.
- Owner allowlist per channel with several accounts per owner; strangers and non-allowlisted groups are ignored and audited; outbound only to owners and allowlisted groups.
- Inbound text becomes `runtime.runner.execute({ objective, source: "gateway:<channel>" })`, or a plan-only brief without a runner; runner `refused` and `dry-run` results are explained.
- Approvals by message: prompts with exact values and a short code to every owner account; «بفرست» / «ارسال کن» / «تایید» / "approve" and «نه» / «رد» / "deny" by quote or code; ambiguous replies ask; a second account on a decided request gets «قبلاً تصمیم گرفته شد»; decisions go through `runtime.approvals` as `owner@<channel>` and resume the run or mission.
- Commands `/status`, `/pending`, `/runs`, `/stop`, `/help`; Persian replies, Latin digits, no bidi isolates, no tables, split long output, per-channel rate limit with outbox.
- Local Persian voice notes with faster-whisper (`gateway-engine/scripts/transcribe.py`, `large-v3-turbo`, CUDA → CPU), gated by the automation policy; `astack gateway voice setup|test`.
- CLI `astack gateway status|test|send|poll|serve|owners|owner|voice|whatsapp`; daemon service `gateway-engine/service.mjs`; doctor line `Gateway:`.
- Bridge safety ported from Hermes Agent (MIT): owner-message gate, LID ↔ phone aliases, outbound id tracking, reconnect backoff, ownership by identity.
- Tests: `tests/verify-gateway.mjs` (loopback pipeline plus fake wapi, Telegram, Graph API and bridge servers).
