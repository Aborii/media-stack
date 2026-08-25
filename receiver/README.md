# backup-receiver

Runs on the **PC**, not the Pi. The Pi's nightly job uploads its backup archive
here; this files it away after checking it.

## Why this and not FTP or SSH

An FTP or SSH server accepts whatever it is handed and writes wherever the
account can reach. This accepts one shape of thing — a gzipped tar named like
the Pi's archives, whose checksum the sender declared before sending — and can
write to one directory. It never extracts the archive, because unpacking
untrusted tars is where path-traversal bugs live and there is no reason to
unpack. It serves nothing back: no GET, no listing, no way to read a backup out
over this port.

## Why the Pi pushes rather than the PC pulling

Pulling would mean the PC holding standing credentials to the Pi and running on
a timer. Pushing means the only credential in play is a key that can do exactly
one thing: upload a backup to one endpoint.

## Setup

```bash
# on the PC
node backup-receiver.js
```

It reads a shared key from `receiver.key` next to it, refuses to start if that
key is shorter than 32 characters, and binds to the **Tailscale address only** —
never `0.0.0.0`. That last part matters: this machine sits on a wifi we do not
control, and a port on every interface would be reachable by anyone else on it.
Tailscale also means the transport is already encrypted and the peer already
authenticated, so the key is a second lock rather than the only one.

The same key goes on the Pi at `/srv/storage/appdata/backup-receiver.key`,
mode 600.

## What it checks before keeping a file

| check | rejects |
|---|---|
| shared key, constant-time compare | `401 no` |
| name matches `media-stack-YYYYMMDD-HHMMSS.tar.gz`, basename only | `400 bad name` |
| SHA-256 matches the declared value | `400 checksum mismatch` |
| gzip magic bytes | `400 not a gzipped tar` |
| `ustar` marker at offset 257 inside | `400 not a gzipped tar` |
| between 1 MB and 4 GB | `400 too small` / `413 too large` |

Verified against all six. A rejected upload is deleted from `.incoming` rather
than left behind looking plausible.

## Environment

| | default |
|---|---|
| `BACKUP_DEST` | `D:\Backups\pi` |
| `BACKUP_BIND` | the Tailscale address |
| `BACKUP_PORT` | `8899` |
| `BACKUP_KEEP` | `7` |

## Starting it at boot, without anyone logging in

```powershell
# elevated PowerShell, once
powershell -ExecutionPolicy Bypass -File D:\Backups\pi\install-receiver-service.ps1
```

Registers a scheduled task that runs **at startup as SYSTEM**, restarts on
failure, and has no execution time limit (the default would kill a long-running
server after three days).

SYSTEM rather than a lower-privileged service account, for a specific reason:
"without login" rules out running as the interactive user, since that requires
storing the account password in the task. The natural alternative, LOCAL
SERVICE, cannot execute `node.exe` — it grants access only to SYSTEM,
Administrators and the owner — and granting it would not survive nvm, which
repoints `C:
vm4w
odejs` at a new folder on every Node version switch and
would silently take the grant with it.

The trade-off is real: a bug in this receiver would be a bug running with full
machine privilege. What bounds it is that the receiver binds only to the
Tailscale address, never extracts an archive, executes nothing, and serves
nothing back out.

The receiver retries its own bind, because at boot it races Tailscale — the
address it wants does not exist until `tailscaled` has been assigned it, and a
bind to a missing address fails instantly with `EADDRNOTAVAIL`. Without the
retry the service would die seconds into every boot, silently, since nothing is
listening yet to report it.

To remove:

```powershell
Unregister-ScheduledTask -TaskName 'Pi Backup Receiver' -Confirm:$false
```
