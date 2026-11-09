"""Remote Codex IDE configuration adapter (stdlib only; stdin entry point is appended)."""
import base64
import contextlib
import fcntl
import json
import os
import platform
import re
import selectors
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

PROVIDER = "magpie_vscode_bridge"
STATE_NAME = ".magpie-remote-bridge.json"
OWNER_RE = re.compile(r"[0-9a-fA-F]{32}\Z")
MAX_OUTPUT = 2 * 1024 * 1024
RPC_TIMEOUT = 12
WATCHDOG_SOURCE = None


class AdapterError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def fail(code, message):
    raise AdapterError(code, message)


def owner_id(value):
    if not isinstance(value, str) or not OWNER_RE.fullmatch(value):
        fail("INVALID_REQUEST", "A 32-character hexadecimal session owner is required.")
    return value.lower()


def safe_directory(path, private=False):
    info = os.lstat(path)
    mode = stat.S_IMODE(info.st_mode)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or mode & 0o022 or (private and mode != 0o700)):
        fail("UNSAFE_PATH", "A managed directory has unsafe ownership, permissions or type.")
    return info


class Child:
    """Bounded pipe reader; every exit path reaps the entire child process group."""
    def __init__(self, argv, home):
        self.process = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(os.environ, CODEX_HOME=home), cwd=home, start_new_session=True)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ, "stdout")
        self.selector.register(self.process.stderr, selectors.EVENT_READ, "stderr")
        self.buffer = b""
        self.stderr = b""
        self.total = 0
        self.closed = False
        self.previous_handlers = {signum: signal.getsignal(signum)
                                  for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
        for signum in self.previous_handlers:
            signal.signal(signum, self._terminated)

    def _terminated(self, signum, frame):
        # A signal can interrupt BufferedWriter.flush() while its lock is held.
        # Reap the child now; Rpc.__exit__ closes pipes after the write unwinds.
        self.close(close_pipes=False)
        raise SystemExit(128 + signum)

    def send(self, message):
        try:
            self.process.stdin.write((json.dumps(message, separators=(",", ":")) + "\n").encode())
            self.process.stdin.flush()
        except (BrokenPipeError, OSError):
            fail("RPC_FAILED", "The official Codex configuration service closed its input.")

    def line(self, deadline):
        while True:
            if b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                return line
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                fail("RPC_TIMEOUT", "The official Codex configuration service timed out.")
            if not self.selector.get_map():
                if self.buffer:
                    line, self.buffer = self.buffer, b""
                    return line
                fail("RPC_FAILED", "The official Codex configuration service exited unexpectedly.")
            for key, _ in self.selector.select(remaining):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    self.selector.unregister(key.fileobj)
                    continue
                self.total += len(data)
                if self.total > MAX_OUTPUT:
                    fail("RPC_OUTPUT_LIMIT", "The official Codex configuration output exceeded its limit.")
                if key.data == "stdout":
                    self.buffer += data
                else:
                    self.stderr = (self.stderr + data)[-32768:]

    def close(self, close_pipes=True):
        if self.closed:
            if close_pipes:
                self._close_pipes()
            return
        self.closed = True
        for signum, handler in self.previous_handlers.items():
            signal.signal(signum, handler)
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except PermissionError:
                self.process.terminate()
            except ProcessLookupError:
                pass
        try:
            self.process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except PermissionError:
                self.process.kill()
            except ProcessLookupError:
                pass
            self.process.wait(timeout=2)
        # Also stop helpers whose parent exited before receiving SIGTERM.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(self.process.pid, signal.SIGKILL)
        self.selector.close()
        if close_pipes:
            self._close_pipes()

    def _close_pipes(self):
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
            pipe.close()


class Rpc:
    def __init__(self, binary, home):
        self.binary, self.home = binary, home
        self.child = None
        self.next_id = 0
        self.deadline = None

    def __enter__(self):
        self.child = Child([self.binary, "--strict-config", "app-server", "--stdio"], self.home)
        self.deadline = time.monotonic() + 35
        return self

    def __exit__(self, *args):
        self.child.close()

    def initialize(self):
        self.call("initialize", {"clientInfo": {"name": "magpie_remote_bridge", "version": "0.3.0"},
                                 "capabilities": {"experimentalApi": True}})
        self.child.send({"method": "initialized"})

    def call(self, method, params):
        self.next_id += 1
        request_id = self.next_id
        self.child.send({"id": request_id, "method": method, "params": params})
        deadline = min(self.deadline, time.monotonic() + RPC_TIMEOUT)
        while True:
            try:
                message = json.loads(self.child.line(deadline))
            except (ValueError, UnicodeError):
                fail("RPC_PROTOCOL", "The official Codex configuration response was invalid.")
            if not isinstance(message, dict):
                fail("RPC_PROTOCOL", "The official Codex configuration response was invalid.")
            if message.get("id") != request_id:
                continue
            if "error" in message:
                # Never forward server messages: they can contain config or credentials.
                fail("CONFIG_WRITE_FAILED" if method == "config/batchWrite" else "RPC_FAILED",
                     "The official Codex configuration request was rejected; recovery metadata was retained.")
            if "result" not in message:
                fail("RPC_PROTOCOL", "The official Codex configuration response was incomplete.")
            return message["result"]


def executable(path):
    info = os.lstat(path)
    return (stat.S_ISREG(info.st_mode) and info.st_uid in (0, os.getuid())
            and not stat.S_IMODE(info.st_mode) & 0o022 and os.access(path, os.X_OK))


def discover_binary(home):
    architecture = {"aarch64": "aarch64", "arm64": "aarch64", "x86_64": "x64", "amd64": "x64"}.get(platform.machine().lower())
    if not architecture:
        fail("UNSUPPORTED_PLATFORM", "This remote CPU architecture is not supported.")
    candidates = []
    for server in (".vscode-server", ".vscode-server-insiders"):
        root = os.path.join(home, server, "extensions")
        if not os.path.isdir(root) or os.path.islink(root):
            continue
        preferred = []
        try:
            with open(os.path.join(root, "extensions.json"), "rb") as handle:
                entries = json.loads(handle.read(MAX_OUTPUT + 1))
            for entry in entries if isinstance(entries, list) else []:
                if not isinstance(entry, dict) or not isinstance(entry.get("identifier"), dict):
                    continue
                if str(entry["identifier"].get("id", "")).lower() != "openai.chatgpt":
                    continue
                location = entry.get("relativeLocation")
                if not location and isinstance(entry.get("location"), dict):
                    location = entry["location"].get("path")
                if isinstance(location, str):
                    preferred.append(os.path.abspath(os.path.join(root, location)))
        except (OSError, ValueError, TypeError):
            pass
        fallback = sorted((os.path.join(root, name) for name in os.listdir(root)
                           if name.lower().startswith("openai.chatgpt-")), reverse=True)
        for folder in preferred + fallback:
            if os.path.dirname(folder) != os.path.abspath(root) or os.path.islink(folder):
                continue
            try:
                with open(os.path.join(folder, "package.json"), "rb") as handle:
                    manifest = json.loads(handle.read(MAX_OUTPUT + 1))
                if manifest.get("name", "").lower() != "chatgpt" or manifest.get("publisher", "").lower() != "openai":
                    continue
                binary = os.path.join(folder, "bin", "linux-" + architecture, "codex")
                if executable(binary) and not any(os.path.islink(p) for p in (
                        os.path.join(folder, "bin"), os.path.dirname(binary))):
                    candidates.append((folder not in preferred, binary))
            except (OSError, ValueError, AttributeError):
                continue
    if not candidates:
        fail("CODEX_NOT_FOUND", "Install the official openai.chatgpt extension on the remote VS Code server.")
    return sorted(candidates, key=lambda item: item[0])[0][1]


def provider_config(port, socket_path, curl):
    base = "http://127.0.0.1:%d/v1" % port
    return {"name": "Magpie Remote Bridge", "base_url": base,
            "model_catalog_url": base + "/codex/models", "wire_api": "responses",
            "requires_openai_auth": False, "supports_websockets": False,
            "auth": {"command": curl, "args": ["--disable", "--silent", "--show-error", "--fail", "--max-time", "3",
                     "--noproxy", "*", "--unix-socket", socket_path, "http://localhost/token"],
                     "timeout_ms": 5000, "refresh_interval_ms": 1000}}


class Adapter:
    # Direct dependency injection is reserved for local tests; main never uses request paths.
    def __init__(self, home=None, binary=None, rpc_factory=Rpc, codex_home=None,
                 watchdog_source=None, watchdog_policy=None):
        self.home = os.path.abspath(home or os.path.expanduser("~"))
        self.codex_home = os.path.abspath(codex_home or os.environ.get("CODEX_HOME") or os.path.join(self.home, ".codex"))
        self.binary_override = binary
        self.rpc_factory = rpc_factory
        self.state_path = os.path.join(self.codex_home, STATE_NAME)
        self.directory_fd = None
        self.curl = None
        self.watchdog_source = watchdog_source
        self.watchdog_policy = watchdog_policy or {}

    def runtime(self):
        if os.name != "posix":
            fail("UNSUPPORTED_PLATFORM", "The adapter requires a POSIX remote host.")
        self.curl = shutil.which("curl")
        if not self.curl or not shutil.which("python3"):
            fail("MISSING_PREREQUISITE", "Install curl and Python 3 on the remote host.")
        self.curl = os.path.realpath(self.curl)
        binary = self.binary_override or discover_binary(self.home)
        if not os.path.isabs(binary) or not executable(binary):
            fail("CODEX_NOT_FOUND", "The official bundled Codex executable is unavailable or unsafe.")
        return binary

    def version(self, binary):
        child = Child([binary, "--version"], self.codex_home if os.path.isdir(self.codex_home) else self.home)
        try:
            line = child.line(time.monotonic() + 8).decode("utf-8").strip()
            if not re.fullmatch(r"codex(?:-cli)? [0-9][A-Za-z0-9.+_-]{0,100}", line):
                fail("UNSUPPORTED_CODEX", "The bundled Codex version response was not recognized.")
            # --version must exit successfully rather than merely print a plausible line.
            try:
                child.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                fail("RPC_TIMEOUT", "The bundled Codex version command timed out.")
            if child.process.returncode != 0:
                fail("UNSUPPORTED_CODEX", "The bundled Codex version command failed.")
            return line.split(" ", 1)[1]
        finally:
            child.close()

    def validate_auth(self, binary):
        provider = provider_config(12345, "/nonexistent/credentials.sock", self.curl)
        lines = ['model_provider="' + PROVIDER + '"', '[model_providers.' + PROVIDER + ']']
        for key, value in provider.items():
            if key != "auth":
                lines.append(key + "=" + json.dumps(value))
        lines.append('[model_providers.' + PROVIDER + '.auth]')
        lines.extend(key + "=" + json.dumps(value) for key, value in provider["auth"].items())
        probe_key = "magpie_unknown_auth_probe"
        with tempfile.TemporaryDirectory(prefix="mpb-config-probe-") as probe:
            path = os.path.join(probe, "config.toml")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("\n".join(lines) + "\n")
            try:
                with self.rpc_factory(binary, probe) as rpc:
                    rpc.initialize()
                    result = rpc.call("config/read", {"includeLayers": True})
                    actual = result.get("config", {}).get("model_providers", {}).get(PROVIDER)
                    # The normalized provider adds defaults (including auth.cwd).
                    # Compare the fields we require while accepting those defaults.
                    if (not isinstance(actual, dict)
                            or any(actual.get(key) != value for key, value in provider.items() if key != "auth")
                            or not isinstance(actual.get("auth"), dict)
                            or any(actual["auth"].get(key) != value for key, value in provider["auth"].items())):
                        fail("UNSUPPORTED_AUTH", "The bundled Codex does not preserve the required provider auth configuration.")
            except AdapterError:
                fail("UNSUPPORTED_AUTH", "The bundled Codex does not support the required strict provider auth configuration.")
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(probe_key + "=true\n")
            rejected = False
            with self.rpc_factory(binary, probe) as rpc:
                try:
                    rpc.initialize()
                    rpc.call("config/read", {"includeLayers": True})
                except AdapterError:
                    stderr = getattr(rpc.child, "stderr", b"")
                    rejected = b"unknown configuration field" in stderr and probe_key.encode() in stderr
            if not rejected:
                fail("UNSUPPORTED_AUTH", "The bundled Codex does not enforce strict provider auth validation.")

    @contextlib.contextmanager
    def locked(self, create=False):
        if create and not os.path.lexists(self.codex_home):
            os.makedirs(self.codex_home, mode=0o700, exist_ok=False)
        if not os.path.lexists(self.codex_home):
            yield False
            return
        info = safe_directory(self.codex_home)
        fd = os.open(self.codex_home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            actual = os.fstat(fd)
            if (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino):
                fail("UNSAFE_PATH", "The Codex home changed during validation.")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                fail("LEASE_BUSY", "Another window is updating this remote Codex account.")
            self.directory_fd = fd
            yield True
        finally:
            self.directory_fd = None
            os.close(fd)

    def read_state(self):
        try:
            fd = os.open(self.state_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return None
        except OSError:
            fail("UNSAFE_STATE", "The remote recovery metadata is not a safe regular file.")
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > 65536):
                fail("UNSAFE_STATE", "The remote recovery metadata has unsafe ownership, permissions or type.")
            with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as handle:
                state = json.load(handle)
            if (not isinstance(state, dict) or state.get("format") != 1
                    or not isinstance(state.get("owner"), str)
                    or not OWNER_RE.fullmatch(state["owner"])
                    or state.get("phase") not in ("preparing", "prepared", "applied", "restored")):
                fail("UNSAFE_STATE", "The remote recovery metadata is invalid.")
            return state
        except (ValueError, UnicodeError):
            fail("UNSAFE_STATE", "The remote recovery metadata is invalid.")
        finally:
            os.close(fd)

    def write_state(self, state, exclusive=False):
        payload = (json.dumps(state, separators=(",", ":")) + "\n").encode()
        if exclusive:
            try:
                fd = os.open(self.state_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            except FileExistsError:
                fail("LEASE_BUSY", "Another window owns this remote Codex account; explicitly restore it first.")
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "wb", closefd=False) as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(fd)
            finally:
                os.close(fd)
        else:
            fd, temporary = tempfile.mkstemp(prefix=".magpie-remote-bridge-", dir=self.codex_home)
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "wb", closefd=False) as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(fd)
                os.replace(temporary, self.state_path)
            finally:
                os.close(fd)
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(temporary)
        os.fsync(self.directory_fd)

    def check_owner(self, state, owner):
        if state["owner"].lower() != owner_id(owner):
            fail("LEASE_BUSY", "Another window owns this remote Codex account; explicitly restore it first.")

    def socket_directory(self, state):
        path = state.get("socketPath")
        identity = state.get("socketIdentity")
        if (not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path
                or os.path.basename(path) != "credentials.sock" or not isinstance(identity, list) or len(identity) != 2):
            fail("UNSAFE_STATE", "The credential socket recovery metadata is invalid.")
        directory = os.path.dirname(path)
        if not os.path.basename(directory).startswith("mpb-ide-") or directory == self.codex_home:
            fail("UNSAFE_STATE", "The credential socket directory is invalid.")
        if not os.path.lexists(directory):
            return directory, False
        info = safe_directory(directory, private=True)
        if [info.st_dev, info.st_ino] != identity:
            fail("UNSAFE_PATH", "The credential socket directory no longer belongs to this session.")
        return directory, True

    def remove_socket(self, state, remove_directory=False):
        directory, exists = self.socket_directory(state)
        if not exists:
            if not remove_directory:
                fail("SOCKET_MISSING", "The credential socket directory is missing; restore and prepare again.")
            return
        path = state["socketPath"]
        if os.path.lexists(path):
            info = os.lstat(path)
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                fail("UNSAFE_SOCKET", "The credential socket path is not an owned Unix socket.")
            os.unlink(path)
        if remove_directory:
            try:
                os.rmdir(directory)
            except OSError:
                fail("CLEANUP_BLOCKED", "The credential socket directory is not empty; recovery metadata was retained.")

    def user_layer(self, result):
        if not isinstance(result, dict):
            fail("RPC_PROTOCOL", "The configuration response is invalid.")
        layers = [layer for layer in result.get("layers", []) if isinstance(layer, dict)
                  and layer.get("name", {}).get("type") == "user"
                  and layer.get("name", {}).get("profile") is None]
        if len(layers) != 1:
            fail("UNSUPPORTED_CONFIG", "A unique base user configuration layer is required.")
        layer = layers[0]
        path = layer["name"].get("file")
        expected = os.path.join(self.codex_home, "config.toml")
        if (not isinstance(path, str) or os.path.abspath(path) != os.path.realpath(expected)
                or os.path.islink(expected) or not isinstance(layer.get("config"), dict)
                or not isinstance(layer.get("version"), str) or not layer["version"]):
            fail("UNSAFE_CONFIG", "The user configuration path or version is unsafe.")
        if os.path.lexists(expected):
            info = os.lstat(expected)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
                fail("UNSAFE_CONFIG", "The user configuration has unsafe ownership or permissions.")
        return layer["config"], path, layer["version"]

    def batch_write(self, rpc, edits, path, version):
        if not edits:
            return
        result = rpc.call("config/batchWrite", {"edits": [
            {"keyPath": key, "value": value, "mergeStrategy": "replace"} for key, value in edits],
            "filePath": path, "expectedVersion": version})
        if not isinstance(result, dict) or result.get("status") != "ok":
            fail("CONFIG_WRITE_FAILED", "Codex did not confirm the configuration write; recovery metadata was retained.")

    def dispatch(self, request):
        if not isinstance(request, dict):
            fail("INVALID_REQUEST", "A JSON request object is required.")
        operation = request.get("operation")
        if operation not in ("inspect", "prepare", "apply", "restore", "cleanup", "rebind"):
            fail("INVALID_REQUEST", "Unknown remote Codex operation.")
        owner = None if operation in ("inspect", "restore") and request.get("owner") is None else owner_id(request.get("owner"))
        with self.locked(create=operation == "prepare") as exists:
            state = self.read_state() if exists else None
            if operation == "inspect":
                binary = self.runtime()
                version = self.version(binary)
                self.validate_auth(binary)
                return {"binary": binary, "version": version, "active": bool(state and state["phase"] == "applied"),
                        "prepared": bool(state and state["phase"] in ("preparing", "prepared")),
                        "recoveryRequired": bool(state)}
            if operation == "prepare":
                if state:
                    self.check_owner(state, owner)
                    if state["phase"] != "prepared":
                        fail("RECOVERY_REQUIRED", "This account has recovery metadata; restore it before preparing again.")
                    _, present = self.socket_directory(state)
                    if not present:
                        fail("SOCKET_MISSING", "The credential socket directory is missing; restore and prepare again.")
                    return {key: state[key] for key in ("socketPath", "binary", "version")}
                binary = self.runtime()
                version = self.version(binary)
                self.validate_auth(binary)
                # Refuse collisions before acquiring a lease or changing user config.
                with self.rpc_factory(binary, self.codex_home) as rpc:
                    rpc.initialize()
                    config = rpc.call("config/read", {"includeLayers": True})
                    self.user_layer(config)
                    self.ensure_provider_absent(config)
                state = {"format": 1, "owner": owner, "phase": "preparing", "binary": binary, "version": version}
                self.write_state(state, exclusive=True)
                directory = tempfile.mkdtemp(prefix="mpb-ide-")
                os.chmod(directory, 0o700)
                info = safe_directory(directory, private=True)
                state.update(phase="prepared", socketPath=os.path.join(directory, "credentials.sock"),
                             socketIdentity=[info.st_dev, info.st_ino])
                self.write_state(state)
                # Recovery is armed before configuration can be applied, even
                # when setup is interrupted before its response reaches VS Code.
                try:
                    self.start_watchdog(state)
                except BaseException:
                    self.remove_socket(state, remove_directory=True)
                    self.delete_state()
                    raise
                return {key: state[key] for key in ("socketPath", "binary", "version")}
            if state is None:
                if operation == "restore":
                    return {"restored": [], "preserved": [], "active": False}
                if operation == "cleanup":
                    return {"cleaned": True, "retained": False}
                fail("NOT_PREPARED", "Prepare the remote Codex account before this operation.")
            if owner is not None:
                self.check_owner(state, owner)
            if operation == "cleanup":
                if state["phase"] in ("applied", "restored"):
                    return {"cleaned": False, "retained": True}
                if "socketPath" in state:
                    self.remove_socket(state, remove_directory=True)
                self.delete_state()
                return {"cleaned": True, "retained": False}
            if operation == "rebind":
                if state["phase"] not in ("prepared", "applied") or request.get("socketPath") != state.get("socketPath"):
                    fail("INVALID_REQUEST", "The credential socket does not match the prepared session.")
                self.remove_socket(state)
                return {"socketPath": state["socketPath"]}
            if operation == "apply":
                return self.apply(request, state)
            return self.restore(state)

    def ensure_provider_absent(self, result):
        configs = [result.get("config", {})] + [layer.get("config", {}) for layer in result.get("layers", []) if isinstance(layer, dict)]
        if any(PROVIDER in config.get("model_providers", {}) for config in configs if isinstance(config, dict)):
            fail("PROVIDER_EXISTS", "The reserved Magpie provider already exists; restore it or choose a clean configuration.")

    def apply(self, request, state):
        model, port = request.get("model"), request.get("remotePort")
        if (not isinstance(model, str) or not model.strip() or len(model) > 4096 or "\0" in model
                or isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535
                or request.get("socketPath") != state.get("socketPath")):
            fail("INVALID_REQUEST", "Model, remote port and the prepared socket path are required.")
        if state["phase"] != "prepared":
            fail("RECOVERY_REQUIRED", "This account must be restored before applying another configuration.")
        _, exists = self.socket_directory(state)
        if not exists or not os.path.lexists(state["socketPath"]):
            fail("SOCKET_MISSING", "Establish the SSH Unix socket forward before applying Codex configuration.")
        socket_info = os.lstat(state["socketPath"])
        if not stat.S_ISSOCK(socket_info.st_mode) or socket_info.st_uid != os.getuid():
            fail("UNSAFE_SOCKET", "The credential forward must be an owned Unix socket.")
        binary = self.runtime()
        if binary != state["binary"]:
            fail("CODEX_CHANGED", "The bundled Codex installation changed; restore and prepare again.")
        with self.rpc_factory(binary, self.codex_home) as rpc:
            rpc.initialize()
            result = rpc.call("config/read", {"includeLayers": True})
            raw, path, version = self.user_layer(result)
            self.ensure_provider_absent(result)
            original = {key: raw.get(key) for key in ("model", "model_provider")}
            if any(value is not None and (not isinstance(value, str) or len(value) > 8192) for value in original.values()):
                fail("UNSUPPORTED_CONFIG", "The original model selection cannot be safely backed up.")
            applied = {"model": model, "model_provider": PROVIDER,
                       "model_providers." + PROVIDER: provider_config(port, state["socketPath"], self.curl)}
            state.update(phase="applied", original=original, applied=applied)
            self.write_state(state)
            self.batch_write(rpc, list(applied.items()), path, version)
        return {"applied": True, "model": model, "provider": PROVIDER}

    def start_watchdog(self, state):
        source = self.watchdog_source
        if source is None:
            with open(__file__, "r", encoding="utf-8") as handle:
                source = handle.read()
        settings = {"home": self.home, "codex_home": self.codex_home, "binary": self.binary_override}
        encoded = base64.b64encode(json.dumps(settings).encode()).decode("ascii")
        policy = base64.b64encode(json.dumps(self.watchdog_policy).encode()).decode("ascii")
        script = (source + '\nprint("READY", flush=True)\n'
                  + 'watch(Adapter(**json.loads(base64.b64decode("' + encoded + '"))), '
                  + repr(state["owner"]) + ', **json.loads(base64.b64decode("' + policy + '")))\n')
        process = subprocess.Popen([sys.executable, "-I", "-"], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   cwd=self.home, start_new_session=True, close_fds=True)
        try:
            process.stdin.write(script.encode("utf-8"))
            process.stdin.close()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                if not selector.select(5) or os.read(process.stdout.fileno(), 64) != b"READY\n":
                    fail("WATCHDOG_FAILED", "Remote automatic recovery could not be started; Codex configuration was not changed.")
        except BaseException:
            process.kill()
            process.wait(timeout=2)
            raise
        finally:
            process.stdout.close()
            if not process.stdin.closed:
                process.stdin.close()

    def restore(self, state):
        restored, preserved = [], []
        if state["phase"] == "applied":
            original, applied = state.get("original"), state.get("applied")
            keys = ("model", "model_provider", "model_providers." + PROVIDER)
            if (not isinstance(original, dict) or set(original) != {"model", "model_provider"}
                    or any(value is not None and (not isinstance(value, str) or len(value) > 8192)
                           for value in original.values())
                    or not isinstance(applied, dict) or set(applied) != set(keys)
                    or applied.get("model_provider") != PROVIDER
                    or not isinstance(applied.get("model"), str)
                    or not isinstance(applied.get(keys[2]), dict)):
                fail("UNSAFE_STATE", "The applied recovery metadata is invalid.")
            binary = self.runtime()
            with self.rpc_factory(binary, self.codex_home) as rpc:
                rpc.initialize()
                result = rpc.call("config/read", {"includeLayers": True})
                raw, path, version = self.user_layer(result)
                current = {"model": raw.get("model"), "model_provider": raw.get("model_provider"),
                           keys[2]: raw.get("model_providers", {}).get(PROVIDER)}
                edits = []
                for key in keys:
                    if current[key] == applied[key]:
                        edits.append((key, original.get(key)))
                        restored.append(key)
                    else:
                        preserved.append(key)
                self.batch_write(rpc, edits, path, version)
            state["phase"] = "restored"
            self.write_state(state)
        if "socketPath" in state:
            self.remove_socket(state, remove_directory=True)
        self.delete_state()
        return {"restored": restored, "preserved": preserved, "active": False}

    def delete_state(self):
        os.unlink(self.state_path)
        os.fsync(self.directory_fd)


def credential_channel_alive(path):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(path)
            connection.sendall(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            line = b""
            while b"\n" not in line and len(line) < 512:
                chunk = connection.recv(512 - len(line))
                if not chunk:
                    return False
                line += chunk
            return line.split(b"\r\n", 1)[0].split(b" ")[1:2] == [b"204"]
    except OSError:
        return False


def watch(adapter, owner, interval=2, grace=60, max_failures=12):
    """Restore only this lease after a sustained loss of its private channel."""
    last_seen, failures = time.monotonic(), 0
    while True:
        try:
            with adapter.locked() as exists:
                state = adapter.read_state() if exists else None
                if not state or state["owner"].lower() != owner:
                    return
                adapter.socket_directory(state)
                path = state["socketPath"]
            if credential_channel_alive(path):
                last_seen = time.monotonic()
                failures = 0
            elif time.monotonic() - last_seen >= grace:
                adapter.dispatch({"operation": "restore", "owner": owner})
                return
        except (AdapterError, OSError) as error:
            if isinstance(error, AdapterError) and error.code == "LEASE_BUSY":
                time.sleep(interval)
                continue
            failures += 1
            if failures >= max_failures:
                # Preserve recovery metadata for the explicit restore command.
                return
        time.sleep(interval)


def main(request):
    try:
        result = Adapter(watchdog_source=WATCHDOG_SOURCE).dispatch(request)
        response = dict(result, ok=True)
    except AdapterError as error:
        response = {"ok": False, "code": error.code, "message": error.message}
    except Exception:
        response = {"ok": False, "code": "REMOTE_ADAPTER_FAILED",
                    "message": "The remote Codex adapter failed; existing recovery metadata was retained."}
    print(json.dumps(response, separators=(",", ":")), flush=True)
