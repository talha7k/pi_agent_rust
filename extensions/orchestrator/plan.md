# Plan: Native Rust Extension Runtime for Pi

## Goal

Replace the QuickJS TypeScript runtime for extensions with a native Rust execution path that delivers:
- **~50-80% less memory** (no QuickJS heap per extension)
- **Zero GC pauses** (no garbage collector)
- **Compile-time type safety** (Rust types instead of erased TS types)
- **Faster startup** (no JS parse/compile step)
- **Sandboxed execution** via WASM (not raw cdylib — too risky)

## Chosen Approach: WASM (WASI) Extensions

The codebase already has a `WasmExtension` scaffold (`src/extensions.rs` ~line 12504) and `WasmExtensionHandle` (~line 16788). We extend this rather than building from scratch.

### Why WASM over cdylib

| Factor | WASM | cdylib |
|--------|------|--------|
| Memory safety | Sandboxed by runtime | Trust-based |
| ABI stability | Stable via WIT/WASI | Fragile, breaks on struct changes |
| Cross-platform | Single `.wasm` file | Per-OS builds (.so/.dll/.dylib) |
| Hot reload | Swap file, instant | Unload/reload .so is racy |
| Existing scaffold | ✅ `WasmExtension` exists | ❌ Nothing |
| Risk | Medium | High |

---

## Phase 1: Inventory & Unblock (~1 day)

- [ ] **1.1** Audit existing `WasmExtension` and `WasmExtensionHandle` code
  - Map every method, every TODO, every `todo!()` / `unimplemented!()`
  - Document what's wired vs stubbed
- [ ] **1.2** Audit existing `native_runtime_experimental` module
  - Extract reusable patterns (snapshot loading, manifest parsing, template rendering)
  - Decide what to keep vs discard
- [ ] **1.3** Check `Cargo.toml` for existing WASM dependencies
  - `wasmtime`, `wasmtime-wasi`, `wasi-common` — versions, features enabled
  - Add if missing, bump if outdated
- [ ] **1.4** Define the WIT (WebAssembly Interface Types) contract
  - File: `docs/wit/extension.wit` (already exists — extend it)
  - Define: `register-tools`, `execute-tool`, `handle-event`, `stream-provider`
  - This is the ABI between Pi host and WASM guest

---

## Phase 2: WASM Runtime Host (~3-5 days)

- [ ] **2.1** Implement `WasmExtensionHost::new()`
  - Create wasmtime `Engine` with config (cranelift, no pooling initially)
  - Create `Store` per extension (isolation)
  - WASI context with stdin/stdout pipes for JSONL communication
- [ ] **2.2** Implement extension loading
  - `load_extension(path)` → compile `.wasm` → instantiate with WASI
  - Validate exports match WIT contract (required functions exist)
  - Extract tool definitions from guest's `register-tools()` export
  - Extract event hook subscriptions from guest's `subscribe-events()` export
- [ ] **2.3** Implement host functions (functions the WASM guest can call into Pi)
  - `host_read_file(path) → bytes` (with capability check)
  - `host_write_file(path, bytes)` (with capability check)
  - `host_exec(cmd, args, stdin) → (stdout, stderr, exit_code)` (with capability check)
  - `host_log(message)` (telemetry/debug)
  - `host_ui_notify(message, level)` (UI notifications)
  - All go through existing `ExtensionPolicy` capability system
- [ ] **2.4** Implement tool execution
  - `execute_tool(tool_name, params_json) → result_json`
  - Stream updates via shared memory or polling
  - Enforce timeout via wasmtime `Store::set_epoch_deadline()`
- [ ] **2.5** Implement event hooks
  - `session_start` → call guest's `on_session_start(config_json)`
  - `before_agent_start` → call guest's `on_before_agent_start(prompt) → prompt_mods`
  - Route through existing `ExtensionSession` trait
- [ ] **2.6** Wire into extension loading path
  - `ExtensionRuntime::Wasm` variant → dispatch to `WasmExtensionHost`
  - Manifest: `"runtime": "wasm"`, `"entrypoint": "extension.wasm"`
  - Fallback: if `.wasm` missing but `Cargo.toml` present, auto-compile first

---

## Phase 3: WASM Guest SDK (~2-3 days)

- [ ] **3.1** Create `pi-ext-sdk` Rust crate (separate crate, `no_std` + `alloc` compatible)
  - `pub fn register_tools(tools: Vec<ToolDef>)` — called in guest `main()`
  - `pub fn on_event(handler: fn(Event) → Option<EventResponse>)`
  - `pub fn read_file(path: &str) → Result<Vec<u8>>` — calls host
  - `pub fn write_file(path: &str, data: &[u8]) → Result<()>` — calls host
  - `pub fn exec(cmd: &str, args: &[&str]) -> Result<ExecResult>` — calls host
  - `pub fn ui_notify(msg: &str, level: &str)` — calls host
- [ ] **3.2** Procedural macro `#[pi_extension]`
  - Wraps `main()` → exports `register-tools`, `execute-tool`, etc.
  - Auto-generates WIT-compatible function signatures
  - Handles JSON serialization/deserialization of params/results
- [ ] **3.3** Build target support
  - `cargo build --target wasm32-wasip1` (WASI preview 1)
  - Also test `wasm32-wasip2` for future compat
  - Add `.cargo/config.toml` with correct target defaults

---

## Phase 4: Port Orchestrator Extension to Rust (~2-3 days)

- [ ] **4.1** Create `extensions/orchestrator-rust/` directory
  - `Cargo.toml` with `pi-ext-sdk` dependency
  - `src/main.rs` with extension logic
- [ ] **4.2** Port `config.ts` → `config.rs`
  - `OrchestratorConfig`, `AgentDef` structs with serde
  - `load_config(cwd: &Path) -> OrchestratorConfig`
  - Global + project merge logic
- [ ] **4.3** Port `executor.ts` → `executor.rs`
  - `run_single_agent()` using `std::process::Command` (already native — no QuickJS overhead)
  - `run_parallel()` using `asupersync` joinset with concurrency limit
  - `run_chain()` with `{previous}` substitution
  - `AbortSignal.timeout()` equivalent via `tokio::time::timeout` or asupersync equivalent
- [ ] **4.4** Port `index.ts` → `main.rs`
  - Register `subagent` tool with schema
  - `on_session_start` → load config, notify user
  - `on_before_agent_start` → inject agent list into system prompt
  - `execute_tool` → dispatch to single/parallel/chain
- [ ] **4.5** Build and test
  - `cargo build --target wasm32-wasip1 --release`
  - Verify `.wasm` output < 500KB
  - Test against running Pi instance

---

## Phase 5: Testing & Benchmarks (~2-3 days)

- [ ] **5.1** Memory benchmarks
  - QuickJS extension baseline: heap size, RSS, GC pause times
  - WASM extension: linear memory size, startup time
  - Target: <5MB per extension (vs ~15-20MB QuickJS heap)
- [ ] **5.2** Latency benchmarks
  - Tool registration time
  - Tool execution latency (host → guest → host round-trip)
  - Event hook latency
  - Target: <100µs per call (vs ~500µs QuickJS)
- [ ] **5.3** Conformance tests
  - Port existing `ext_conformance` fixtures to WASM
  - Verify same behavior as JS extension
  - Add WASM-specific tests: memory limits, timeout enforcement, panic recovery
- [ ] **5.4** Edge cases
  - Extension panic → host recovers gracefully, doesn't crash Pi
  - OOM in WASM → trap, report error, continue
  - Infinite loop → epoch deadline timeout kills it
  - Malformed `.wasm` → clear error message
- [ ] **5.5** Security audit
  - Verify all host functions go through `ExtensionPolicy`
  - No filesystem escape via WASI sandbox
  - No network access unless explicitly granted

---

## Phase 6: Documentation & Migration (~1 day)

- [ ] **6.1** Update `docs/extension-architecture.md`
  - WASM extension lifecycle diagram
  - WIT contract reference
  - SDK API docs
- [ ] **6.2** Create migration guide
  - TypeScript → Rust porting checklist
  - Common patterns mapping (TS `spawn` → Rust `Command`, TS `AbortSignal` → Rust timeout)
  - Build instructions (`cargo build --target wasm32-wasip1`)
- [ ] **6.3** Update `docs/extension-catalog.json`
  - Add `runtime: "wasm"` entries
  - Mark which extensions have WASM versions available
- [ ] **6.4** Create example WASM extension
  - Minimal `hello-world` in `examples/wasm-hello/`
  - Shows tool registration, event hooks, host function calls
  - Used as template for new extensions

---

## Timeline Summary

| Phase | Duration | Cumulative |
|-------|----------|------------|
| Phase 1: Inventory & Unblock | 1 day | 1 day |
| Phase 2: WASM Runtime Host | 3-5 days | 4-6 days |
| Phase 3: WASM Guest SDK | 2-3 days | 6-9 days |
| Phase 4: Port Orchestrator | 2-3 days | 8-12 days |
| Phase 5: Testing & Benchmarks | 2-3 days | 10-15 days |
| Phase 6: Docs & Migration | 1 day | 11-16 days |

**Realistic estimate: 2-3 weeks** for a single developer working full-time.

---

## Expected Outcomes

| Metric | QuickJS (current) | WASM (target) | Improvement |
|--------|-------------------|---------------|-------------|
| Memory per extension | ~15-20 MB | ~2-5 MB | **~75% reduction** |
| Startup time | ~50-200ms (parse+compile) | ~5-10ms (instantiate) | **~95% faster** |
| Tool call latency | ~500µs | ~50-100µs | **~80% faster** |
| GC pauses | Yes (mark-compact) | None | **Eliminated** |
| Type safety | Design-time only | Compile-time | **Full** |
| Sandbox | QuickJS capability policy | WASM sandbox + capability policy | **Double sandbox** |
| Binary size (extension) | .ts source (~10KB) | .wasm (~200-500KB) | Larger but compiled |
| Cross-platform | QuickJS handles it | Single .wasm file | **Universal** |
