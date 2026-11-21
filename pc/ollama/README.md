# Ollama on the PC

Two Ollamas run on the PC's RTX 3080 Ti for the mini, because the GPU does in
seconds what the mini's CPU takes minutes for:

| Name | Task | Port | For | Models |
| --- | --- | --- | --- | --- |
| paperless | `ollama` | 11434 | paperless-gpt (`stacks/paperless`): reading and naming documents | `qwen2.5vl:7b`, `qwen2.5:14b` |
| subtitles | `ollama-subtitles` | 11435 | subfill (`stacks/subfill`): translating subtitles to Arabic | `translategemma:12b` |

The mini reaches them over the direct cable at `http://10.10.10.1:11434` and
`:11435`. Each listens on that address only, and the firewall lets in the mini
(`10.10.10.3`) and nothing else. Ollama has no sign-in, so those rules are its
only lock.

Both come from the same `run-ollama.ps1` (`-Name subtitles` for the second),
and share the download, the models folder and the pause. Each has its own
switch, logs and request log.

## When they run

- **PC on, not paused:** paperless-gpt reads new documents as they arrive, and
  subfill's PC node translates subtitles.
- **The GPU's order: the chat model, then paperless, then subtitles.**
  - The subtitles Ollama stays stopped while the paperless one has a model
    loaded. It starts again once paperless has had no model loaded for 30 s,
    which is 2 minutes after paperless's last page, plus that 30 s.
  - A document that arrives while subtitles hold the GPU loads its model with
    the GPU nearly full, so part of it lands on the CPU. The subtitles Ollama
    stops within 2 s, and that document finishes on the model as loaded,
    slower. It is not reloaded on the freed GPU: that would cut off the
    reading, and paperless-gpt does not retry one. After 2 minutes idle the
    model unloads, so the next document has the whole GPU.
  - Both stop while storychat's chat model is loaded.
- **With subfill's PC node.** It is in `stacks/subfill` from
  Aborii/media-stack#116 on.
- **PC off or asleep:** nothing answers.
  - The gate on the mini (`scripts/paperless-gpt-gate.sh`) stops
    paperless-gpt. New documents wait with their `ai-new` tag and Paperless's
    own OCR, and paperless-gpt catches up when the PC is back.
  - subfill carries on with its mini node, and an episode the PC was
    translating starts again later.
  - Nothing here keeps the PC awake or wakes it. subfill holds a lease only
    after the owner asks Malak to wake the PC for subtitles.
- **Paused:** both Ollamas are stopped and the GPU is free. The mini's work
  waits the same way.

## Tray icon

An **AI** dot in the notification area shows what it is doing:

| Colour | Means |
| --- | --- |
| green | ready, nothing loaded |
| blue | reading a document |
| teal | translating subtitles |
| amber | paused by you |
| grey | the paperless models are switched off |
| purple | paused because storychat has the GPU |
| red | not answering: starting, or the `ollama` task is stopped |

Right-click it to pause (until you resume, or for 1 or 3 hours), resume, or
open either start-and-stop log. Double-click toggles pause. Pause covers every
model: both Ollamas stop, and storychat-server unloads the chat model and
loads nothing until you resume.

Per model, the menu also has:

- **The state of each model.**
  - **Chat model:** loaded, not loaded, or switched off. This comes from
    KoboldCpp's port (5001; pass `-ChatPort` if it differs).
  - **Subtitle model:** translating, ready, waiting while paperless works,
    paused, switched off, or not running.
- **Unload the chat / paperless / subtitle model now:** the model stops at
  once, even mid-reply, mid-page or mid-batch. The next message, document or
  batch loads it again. A cut-off reply or subtitle batch is done again; a
  cut-off Paperless document fails its AI reading (paperless-gpt does not
  retry it), so run it again with `rerun-ai.py`.
- **Chat / Paperless / Subtitle model can load:** untick one to keep that
  model from loading until you tick it again. A loaded model unloads within a
  few seconds. What happens to the work meanwhile:
  - **Chat:** a message gets "the chat model is switched off on the PC" in
    SillyTavern.
  - **Paperless:** documents wait on the mini with their `ai-new` tag, as when
    paused.
  - **Subtitles:** subfill's PC node goes offline, and its mini node carries
    on.

The tray only writes files in `I:\AI\ollama`:
- `pause\user`;
- `off\chat`, `off\paperless` and `off\subtitles`;
- `unload\chat`, `unload\paperless` and `unload\subtitles`.

Who acts on them:
- **`run-ollama.ps1`:** the paperless and subtitles files, and the pause, each
  copy for its own name.
- **storychat-server** (`AI_CONTROL_DIR` in its `.env`): the chat files and
  the pause.

The menu also shows when the mini last checked in with each Ollama, and when
each last got work:
- paperless-gpt's gate asks every 30 s;
- subfill's PC node asks before each episode and about every minute while idle.

**Show paperless requests…** and **Show subtitle requests…** each open a
window listing that Ollama's requests, newest first, refreshed every 5 s:
- each line has its time, how long it took and whether it worked;
- tick the box to include the check-ins;
- if the mini has not checked in for a while, the cable or the mini is down.

The icon starts at sign-in from the Startup folder. "Hide this icon" only
closes the icon; the AI keeps running. Windows may tuck a new icon under the
`^` arrow at first: drag it onto the taskbar to keep it in view.

## Pausing

- The tray icon's menu, or double-click it.
- **Pause AI** on the desktop or in the Start menu: until **Resume AI**.
- `pause.ps1 -Hours 3`: for three hours, then it resumes by itself.
- **storychat** pauses them too while its chat model is loaded, because they
  would not fit in the GPU's 12 GB together. The Ollamas come back when the
  chat model unloads, 30 minutes after the last message.
  - storychat waits only for the paperless Ollama to stop before loading.
  - The subtitles one reads the same pause file on the same 2-second loop, so
    it stops within a few seconds of it, but storychat does not wait for it.
    When paperless is not running at all, the chat model can start loading
    while the subtitle model still holds the GPU for those seconds.
  - Making storychat-server wait for both is its own change.

Pausing takes a few seconds. A subtitle batch or chat reply that was being
worked on when it paused is done again later. A Paperless document that was
being read fails its AI reading, since paperless-gpt does not retry it; run it
again with `rerun-ai.py`.

## Install

```powershell
# elevated PowerShell
powershell -ExecutionPolicy Bypass -File I:\Projects\media-stack\pc\ollama\install.ps1
```

It does five things:
- downloads Ollama into `I:\AI\ollama`;
- registers tasks `ollama` and `ollama-subtitles` (as you, at boot, signed in
  or not);
- adds a firewall rule for each port, and the shortcuts;
- restarts the tray icon, so it runs the new script;
- pulls `qwen2.5vl:7b`, `qwen2.5:14b` and `translategemma:12b` (about 23 GB,
  in `I:\AI\ollama\models`), trying each up to three times. It ends with
  "Done." only when all three are there; otherwise it says which did not
  download, in red, and exits with 1. A model already there that could not be
  checked for a newer version (no internet) gets a yellow note and is kept.

It is safe to run again on a PC that has only the paperless one: it adds the
second without touching the first's download or models. A model already
there is only checked, not downloaded again.

## Tests

`run-ollama.Tests.ps1` checks the runner checks the subtitle Ollama's yield to
paperless depends on, with the port and process lookups faked. It uses the
Pester that ships with Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Pester I:\Projects\media-stack\pc\ollama"
```

`uninstall.ps1` removes both tasks, both rules and the shortcuts, and keeps the
download and the models.

## Logs

The paperless Ollama's, named as before there were two:

- `I:\AI\ollama\run-ollama.log`: when it started, stopped and paused.
- `I:\AI\ollama\ollama-serve.log`: Ollama's own output for the current run.
- `I:\AI\ollama\ollama-requests.log`: one line per request for the current
  run. At each start the last run's lines move to
  `ollama-requests-history.log`, which rolls over to `.1` past 5 MB. The tray
  icon reads these.

The subtitles Ollama's are the same with `-subtitles` in the name:
`run-ollama-subtitles.log`, `ollama-subtitles-serve.log`,
`ollama-subtitles-requests.log` and `ollama-subtitles-requests-history.log`.
