# Changelog

## 0.3.3

- Automatically restore the remote Codex sidebar configuration before disconnecting, changing hosts or shutting down normally, while preserving later user edits.
- Arm a detached remote recovery watchdog before setup completes. Restore only the owned lease after 60 seconds of continuous credential-channel loss, including forced window closure; keep short reconnects working.
- Serialize restoration with new connections, bound shutdown recovery, report unconfirmed restoration and retain explicit recovery for failed writes or older leases.

## 0.3.2

- Defer buffered-pipe cleanup until RPC unwinding when SIGTERM, SIGHUP or SIGINT interrupts a write, while still terminating and reaping the child immediately.
- Add deterministic regressions for signals during buffered writes to prevent the intermittent Linux CI failure.
- Add opt-in Marketplace OIDC publishing after all six CI matrix jobs succeed on main, with duplicate-version handling and retained VSIX artifacts.

## 0.3.1

- Accept the official Codex extension's null CLI executable default when connecting the sidebar, while continuing to reject nonempty custom executable overrides.
- Preserve explicit null settings in the VS Code test fixture and cover null, missing, empty and whitespace defaults.

## 0.3.0 (development)

- Add commands to connect the official remote Codex sidebar and restore its previous provider selection through Codex's configuration RPC.
- Obtain provider credentials through a private SSH-forwarded Unix socket and command auth, without token files, anonymous TCP endpoints, or changes to the official extension executable.
- Guard the remote account with an exclusive lease and durable recovery metadata; preserve user edits during restoration and recover credential forwarding after SSH reconnect.
- Check bundled Codex auth compatibility strictly, bound configuration subprocesses, and reap them on cancellation and hangup.
- Add isolated adapter and UI tests plus an optional real app-server test against a local Responses fixture. Remote sidebar UI and live model acceptance remain pending.

## 0.2.1

- Check the remote Claude Code or Codex CLI before launch, including interactive shell initialization and user bin directories.
- Launch the resolved executable by absolute path and add only its directory to that process PATH, supporting native binaries and nvm installations.
- Offer a configured remote terminal, official installation instructions and retry when a CLI is missing; preserve the working gateway and distinguish check failures from missing programs.
- Cancel stale checks and reject results from replaced sessions or tunnels.

## 0.2.0

- Extract a cancellable session state machine. Commands join an in-progress reconnect instead of revoking the running agents' token and terminals.
- Add a status bar actions menu, cancellable connection progress, actionable error notifications, settings shortcuts and a getting-started walkthrough.
- Localize command titles, settings and runtime UI for English and Simplified Chinese.
- Store SSH targets per workspace authority, migrate legacy mappings, and support manual SSH ports and bracketed IPv6 input.
- Harden network cancellation, HTTP/catalog error handling, authentication prompt concurrency and process cleanup.
- Add isolated lifecycle and command regression tests, model-import and localization checks, and a cross-platform CI matrix.

## 0.1.3

- Decode Remote-SSH workspace addresses instead of treating hex-encoded JSON as a DNS hostname; preserve the SSH user and explicit port.
- Automatically repair affected saved host mappings, prioritize the current workspace target, and retain intentional host overrides.
- Log the resolved target and connection stages to distinguish local gateway, SSH, and remote HTTP failures.

## 0.1.2

- Prepare Marketplace metadata, search keywords, icon and privacy documentation.
- Package with Microsoft's official vsce tool and exclude local reports and development files.

## 0.1.1

- macOS/Linux password and key-passphrase authentication through VS Code secure input.
- Private per-session SSH control socket reuses authentication for remote probes.
- No password persistence; cancelled prompts abort authentication.

## 0.1.0

- Local UI extension, loopback reverse SSH tunnel, authenticated model API proxy.
- End-to-end remote HTTP probe, bounded reconnect, session cleanup.
- Remote terminals and Claude Code / Codex CLI launchers; model picker.
- Local Claude model environment import; no provider credential copying.
