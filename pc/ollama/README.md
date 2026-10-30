# Ollama on the PC

The models that read and name documents for paperless-gpt
(`stacks/paperless`) run on the PC's RTX 3080 Ti, not on the mini's CPU.
A page takes seconds there and about four minutes on the mini.

The mini reaches it over the direct cable at `http://10.10.10.1:11434`. Ollama
listens on that address only, and the firewall lets in the mini (`10.10.10.3`)
and nothing else. Ollama has no sign-in, so that rule is its only lock.

## When it runs

- **PC on, not paused:** paperless-gpt reads new documents as they arrive.
- **PC off or asleep:** nothing answers. The gate on the mini
  (`scripts/paperless-gpt-gate.sh`) stops paperless-gpt, and new documents
  wait with their `ai-new` tag and Paperless's own OCR. When the PC is back,
  the gate starts paperless-gpt and it catches up. Nothing here keeps the PC
  awake or wakes it.
- **Paused:** Ollama is stopped and the GPU is free. Documents wait the same way.

## Tray icon

An **AI** dot in the notification area shows what it is doing:

| Colour | Means |
| --- | --- |
| green | ready, nothing loaded |
| blue | reading a document |
| amber | paused by you |
| purple | paused because storychat has the GPU |
| red | not answering: starting, or the `ollama` task is stopped |

Right-click it to pause (until you resume, or for 1 or 3 hours), resume, or
open the log. Double-click toggles pause. It starts at sign-in from the
Startup folder; "Hide this icon" only closes the icon, the AI keeps running.
Windows may tuck a new icon under the `^` arrow at first: drag it onto the
taskbar to keep it in view.

## Pausing

- The tray icon's menu, or double-click it.
- **Pause AI** on the desktop or in the Start menu: until **Resume AI**.
- `pause.ps1 -Hours 3`: for three hours, then it resumes by itself.
- **storychat** pauses it too while its chat model is loaded, because both
  would not fit in the GPU's 12 GB. Ollama comes back when the chat model
  unloads, 30 minutes after the last message.

Pausing takes a few seconds. A page that was being read when it paused is
read again later.

## Install

```powershell
# elevated PowerShell
powershell -ExecutionPolicy Bypass -File I:\Projects\media-stack\pc\ollama\install.ps1
```

It downloads Ollama into `I:\AI\ollama`, registers task `ollama` (as you, at
boot, signed in or not), adds the firewall rule and the shortcuts, and pulls
`qwen2.5vl:7b` and `qwen2.5:14b` (about 15 GB, in `I:\AI\ollama\models`).

`uninstall.ps1` removes the task, the rule and the shortcuts, and keeps the
download and the models.

## Logs

- `I:\AI\ollama\run-ollama.log`: when it started, stopped and paused.
- `I:\AI\ollama\ollama-serve.log`: Ollama's own output for the current run.
