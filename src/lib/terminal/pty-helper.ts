/**
 * A pseudo-terminal without a native module.
 *
 * An interactive shell needs a PTY - without one there is no prompt, no line
 * editing, no Ctrl+C and nothing like `vim` or `htop`. Node cannot allocate one
 * by itself. `node-pty` can, but it is a compiled addon: another toolchain in
 * the image build, another binary per platform in the desktop app, and a
 * failure that shows up at install time on somebody else's machine. Python
 * ships `pty` in its standard library, the image already carries Python for the
 * document toolbelt, and a few dozen lines are enough to relay bytes between
 * the shell and a pair of pipes.
 *
 * The helper has three channels to Node: stdin carries keystrokes in, stdout
 * carries the terminal's output out, and fd 3 carries control lines - today only
 * `R <rows> <cols>`, the window size, which is what makes a resized panel
 * redraw its text at the right width. When Node goes away (stdin closes) the
 * shell is hung up rather than left running.
 *
 * It is run with `-I` (isolated): without it the interpreter puts the current
 * directory first on its path, and the current directory is somebody's project,
 * so a file named `pty.py` or `select.py` in it would replace the standard
 * module and run in place of this. That is not hypothetical - a probe script
 * called `struct.py` once ran by accident for exactly this reason.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export const PTY_HELPER_SOURCE = String.raw`
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def winsize(rows, cols):
    return struct.pack("HHHH", rows, cols, 0, 0)


def main():
    rows, cols = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]

    pid, master = pty.fork()
    if pid == 0:
        # The shell. Fd 3 is our control pipe and is none of its business: a
        # program that read it would swallow the window-size lines.
        try:
            os.close(3)
        except OSError:
            pass
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, winsize(rows, cols))
        except OSError:
            pass
        try:
            os.execvp(argv[0], argv)
        except OSError as exc:
            os.write(2, ("cannot start %s: %s\r\n" % (argv[0], exc)).encode())
            os._exit(127)

    os.set_blocking(master, False)
    state = {"deadline": None}

    def hang_up(sig):
        try:
            os.killpg(pid, sig)
        except OSError:
            try:
                os.kill(pid, sig)
            except OSError:
                pass

    def on_term(signum, frame):
        hang_up(signal.SIGHUP)
        if state["deadline"] is None:
            state["deadline"] = time.time() + 2.0

    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        signal.signal(getattr(signal, name), on_term)

    def write_out(data):
        view = memoryview(data)
        while view:
            try:
                written = os.write(1, view)
            except BlockingIOError:
                select.select([], [1], [], 0.1)
                continue
            view = view[written:]

    pending = bytearray()
    ctl_buffer = b""
    stdin_open = True
    ctl_open = True
    master_open = True
    exited = False
    status = 0

    def drain():
        # What the shell printed on its way out is still in the pipe.
        while True:
            try:
                data = os.read(master, 65536)
            except (BlockingIOError, OSError):
                return
            if not data:
                return
            write_out(data)

    try:
        while master_open:
            readers = [master]
            writers = []
            if stdin_open:
                readers.append(0)
            if ctl_open:
                readers.append(3)
            if pending:
                writers.append(master)
            try:
                ready, writable, _ = select.select(readers, writers, [], 0.2)
            except (InterruptedError, OSError) as exc:
                if getattr(exc, "errno", None) == errno.EINTR:
                    ready, writable = [], []
                else:
                    raise

            for fd in ready:
                if fd == master:
                    try:
                        data = os.read(master, 65536)
                    except BlockingIOError:
                        continue
                    except OSError:
                        data = b""
                    if data:
                        write_out(data)
                    else:
                        master_open = False
                elif fd == 0:
                    data = os.read(0, 65536)
                    if data:
                        pending.extend(data)
                    else:
                        stdin_open = False
                        hang_up(signal.SIGHUP)
                        if state["deadline"] is None:
                            state["deadline"] = time.time() + 2.0
                elif fd == 3:
                    data = os.read(3, 4096)
                    if not data:
                        ctl_open = False
                        continue
                    ctl_buffer += data
                    while b"\n" in ctl_buffer:
                        line, ctl_buffer = ctl_buffer.split(b"\n", 1)
                        parts = line.split()
                        if len(parts) == 3 and parts[0] == b"R":
                            try:
                                fcntl.ioctl(master, termios.TIOCSWINSZ, winsize(int(parts[1]), int(parts[2])))
                            except (ValueError, OSError):
                                pass

            if pending and master in writable:
                try:
                    written = os.write(master, bytes(pending[:4096]))
                    del pending[:written]
                except BlockingIOError:
                    pass
                except OSError:
                    pending.clear()

            if state["deadline"] is not None and time.time() > state["deadline"]:
                hang_up(signal.SIGKILL)

            if not exited:
                done, raw = os.waitpid(pid, os.WNOHANG)
                if done == pid:
                    exited = True
                    status = raw
            if exited:
                drain()
                break
    except BrokenPipeError:
        hang_up(signal.SIGHUP)

    if not exited:
        deadline = time.time() + 2.0
        while time.time() < deadline:
            done, raw = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                exited = True
                status = raw
                break
            time.sleep(0.05)
        if not exited:
            hang_up(signal.SIGKILL)
            try:
                _, status = os.waitpid(pid, 0)
            except ChildProcessError:
                status = 0

    if hasattr(os, "waitstatus_to_exitcode"):
        code = os.waitstatus_to_exitcode(status)
    elif os.WIFEXITED(status):
        code = os.WEXITSTATUS(status)
    else:
        code = -os.WTERMSIG(status)
    sys.exit(code if code >= 0 else 128 - code)


main()
`;

export interface PtyAvailability {
  python: string | null;
  reason: string | null;
}

let cached: PtyAvailability | null = null;

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * On macOS `/usr/bin/python3` exists on every machine and is not Python: when
 * the command line tools are missing it is a stub that opens an installer
 * dialog. Starting it to find out would put that dialog in front of somebody
 * who only wanted a shell, so it is used only where the tools are known to be
 * installed.
 */
function commandLineToolsInstalled(): boolean {
  try {
    return spawnSync("xcode-select", ["-p"], { stdio: "ignore", timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
}

function findPython(env: NodeJS.ProcessEnv): string | null {
  const override = env.EGGENT_TERMINAL_PYTHON?.trim();
  if (override) return isExecutable(override) ? override : null;

  let toolsChecked: boolean | null = null;
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, "python3");
    if (!isExecutable(candidate)) continue;
    if (process.platform === "darwin" && candidate === "/usr/bin/python3") {
      toolsChecked ??= commandLineToolsInstalled();
      if (!toolsChecked) continue;
    }
    return candidate;
  }
  return null;
}

/**
 * A Python that can run the helper, or the reason there is none.
 *
 * Asked once per process: the answer does not change while the server runs, and
 * the check starts an interpreter.
 */
export function resolvePtyAvailability(env: NodeJS.ProcessEnv = process.env): PtyAvailability {
  if (cached) return cached;
  if (process.platform === "win32") {
    cached = { python: null, reason: "windows" };
    return cached;
  }
  const python = findPython(env);
  if (!python) {
    cached = { python: null, reason: "no-python" };
    return cached;
  }
  const probe = spawnSync(python, ["-I", "-c", "import pty, termios, fcntl, select"], {
    stdio: "ignore",
    timeout: 5000,
  });
  cached = probe.status === 0 ? { python, reason: null } : { python: null, reason: "no-pty-module" };
  return cached;
}

/** For tests, which change the environment between checks. */
export function resetPtyAvailabilityCache(): void {
  cached = null;
}
