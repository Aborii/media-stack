# Tdarr: making video files smaller

Tdarr takes a video file, re-encodes it into a much smaller file that looks almost the same,
and puts it in place of the original. Sonarr and Jellyfin keep working with it as before.

A real example from this library, one episode of Hawaii Five-0:

| | Size | Video | Audio |
|---|---|---|---|
| As downloaded | 3,197 MB | H.264, 1080p | EAC3 5.1 surround |
| After Tdarr | 525 MB | HEVC, 1080p | AAC stereo |

That is about 84% smaller, at the same resolution, with the subtitles kept.

This guide assumes nothing. Read it top to bottom the first time. After that, the everyday
routine is [Part 3: Convert a season](#part-3-convert-a-season).

---

## How the pieces fit together

There are two halves, on two machines.

| Piece | Where it runs | What it does |
|---|---|---|
| **Tdarr server** | The Pi, in Docker (`stacks/management/compose.yaml`) | Keeps the list of files, the settings and the queue. It never encodes anything itself. |
| **Tdarr node** | The Windows desktop, named `aborii-pc` | Does the actual encoding, on the graphics card. |

The node reads and writes the files through the Samba share, which is mapped as `T:` on the
desktop. So the server and the node see the same folders under different names:

| What Tdarr shows (the Pi) | The same folder on the desktop |
|---|---|
| `/media` | `T:\media\library` |
| `/temp` | `T:\media\tdarr-cache` |

When Tdarr shows `/media/tv/Hawaii Five-0/Season 07`, that is
`T:\media\library\tv\Hawaii Five-0\Season 07` on the desktop.

**The desktop has to be on for anything to happen.** If it is off or asleep, files wait in the
queue.

---

## Words you will see

- **Library** - a folder Tdarr looks after, plus the settings for what to do with its files.
- **Flow** - the recipe. A chain of steps such as "is this file H.264?", "encode it to HEVC",
  "replace the original".
- **Node** - a computer that does the work. Here there is one, `aborii-pc`.
- **Worker** - one job running on a node. This node runs one job at a time, on the GPU.
- **Scan** - Tdarr looking through a library's folder and adding the files it finds to the
  queue.
- **Queue** - files waiting their turn.
- **Cache** - scratch space where the new file is built before it replaces the old one.

---

## Before you start: a checklist

Go through this every time, before converting anything.

### 1. The desktop is on and the node is running

Look for the **Tdarr tray icon** in the Windows system tray, near the clock.

If it is not there, start it by double-clicking:

```
C:\Tdarr\Tdarr_Node\Tdarr_Node_Tray.exe
```

To make it start with Windows: press **Windows + R**, type `shell:startup`, press Enter, and
put a shortcut to `Tdarr_Node_Tray.exe` in the folder that opens.

### 2. Tdarr can see the node

Open Tdarr in a browser: <http://aboriis-pi:8265>

On the **Home** page, find the **Nodes** section. There should be a row for `aborii-pc`, with
**Transcode GPU** set to `1`. If there is no row, the node is not connected. Go back to step 1.

Also on the Home page, make sure **Pause all nodes** is switched off.

### 3. The episodes are fully downloaded

In Sonarr, open **Activity** and make sure nothing for that show is still downloading. Tdarr
should only touch files Sonarr has finished importing.

### 4. Do not click the Tdarr update

Tdarr sometimes shows a banner saying a new version is available. **Ignore it.** The server on
the Pi and the node on the desktop must run exactly the same version. Updating only one of them
stops all encoding until the other one is updated too.

---

## Part 1: The flow (the recipe)

The flow is already built and saved. You do not need to build it again. This part explains what
it does, and how to rebuild it if it is ever lost.

### What the flow is called

On the **Flows** page it is named:

> **H50 S07 HEVC 1080p (QP28 + AAC 2ch, guarded)**

Despite the name, nothing in it is specific to Hawaii Five-0. It works for any show. You can
rename it to something general, like *HEVC 1080p guarded*.

### What each step does

The steps run top to bottom. Each step's **output 1** connects to the next step.

| # | Step, as named in Tdarr | What it does, in plain words |
|---|---|---|
| 1 | **Input File** | Starts the recipe with one file. |
| 2 | **Check Video Codec** | Only carries on if the video is H.264. A file that is already HEVC stops here, untouched, so nothing gets encoded twice. |
| 3 | **Begin Command** | Starts building the encoding command. |
| 4 | **Set Video Encoder** | Encodes the video to HEVC on the graphics card. |
| 5 | **Ensure Audio Stream** | Adds a stereo AAC audio track, made from the English audio. |
| 6 | **Remove Stream By Property** | Removes the original surround track (EAC3), which is huge. |
| 7 | **Execute** | Runs the encode. This is the step that takes minutes. |
| 8 | **Compare File Size Ratio** | Checks the new file is between 5% and 40% of the original's size. |
| 9 | **Replace Original File** | Puts the new file in place of the original. |

Step 8 is the safety net. If an encode goes wrong and the new file is tiny, or barely smaller,
the flow stops before step 9 and **the original is kept**.

### The exact settings, if you ever rebuild it

Go to **Flows** and press **Flow +** to create a blank flow. Drag the plugins in from the list on
the left, in the order above, and connect each one to the next from its **output 1**.

Then double-click each of these plugins and set:

**Check Video Codec**
- Codec: `h264`

**Set Video Encoder**
- Output Codec: `hevc`
- Enable FFmpeg Preset: on
- FFmpeg Preset: `slow`
- Enable FFmpeg Quality: on
- FFmpeg Quality: `28`
- Hardware Encoding: on
- Hardware Type: `nvenc`
- Hardware Decoding: **off**
- Force Encoding: on

**Ensure Audio Stream**
- Audio Encoder: `aac`
- Language: `en`
- Channels: `2`
- Enable Bitrate: on
- Bitrate: `128k`

**Remove Stream By Property**
- Codec Type: `audio`
- Property To Check: `codec_name`
- Values To Remove: `eac3`
- Condition: `includes`

**Compare File Size Ratio**
- Greater Than: `5`
- Less Than: `40`

The newest version of Compare File Size Ratio comes with `40` and `110` already filled in.
Change them, or it will throw away every good encode.

Press **Save**.

### What "quality 28" means

Lower numbers give a better picture and bigger files. Higher numbers give smaller files and a
softer picture.

- `25` - bigger files, very close to the original
- `28` - what this library uses; about 350-550 MB for a 45-minute episode at 1080p
- `30` and up - noticeably softer

---

## Part 2: Test on one episode first

Do this whenever you convert **a new show**, or episodes from **a different release group** than
before. It takes ten minutes and protects the real files.

There is a library just for this, called **H50 720p test**. It points at its own folder,
`/media/_tdarr-test`, which Jellyfin and Sonarr never look at.

1. **Copy one episode into the test folder.** In Windows Explorer, copy an episode into
   `T:\media\library\_tdarr-test`. Copy it through `T:` like this, not with a command on the
   Pi. [Tdarr says it cannot find the file](#tdarr-says-it-cannot-find-the-file) explains why.

2. **Pick the flow for the test library.** Go to **Libraries**, select **H50 720p test**, open
   the **Transcode Options** tab, choose **Flows**, and pick the flow from Part 1 in the
   dropdown.

3. **Start the scan.** With **H50 720p test** still selected, press the **Options** button under the list of libraries
   (next to **Upload**, not the one beside **Library +**) and choose **Scan (Find new)**.

4. **Watch it.** On the **Home** page, the **Nodes** section shows the file, the percentage, the
   speed (FPS) and the time left (ETA).

5. **Check the size.** When it finishes, the file moves to the
   **Transcode: Success/Not Required** tab. The new file in `T:\media\library\_tdarr-test`
   should be roughly 10-20% of the original's size.

6. **Watch a few minutes of it** in VLC, next to the original. Look at dark scenes and fast
   action, because that is where a bad encode shows first.

7. **Delete the test file** from `T:\media\library\_tdarr-test` once you are happy.

---

## Part 3: Convert a season

This is the routine to follow every time.

### Step 1. Pick the season folder

1. In Tdarr, go to **Libraries**.
2. Select the library called **H50 S07 HEVC 1080p**. It is the one for converting TV seasons.
   You can rename it to something general, like *TV season convert*.
3. Open the **Source** tab.
4. Press **Browse** and choose the season folder, for example
   `/media/tv/Hawaii Five-0/Season 08`.

### Step 2. Check the switches on the Source tab

They must be set like this:

| Setting | Should be |
|---|---|
| Process Library | **on** |
| Transcodes | **on** |
| Health Checks | off |
| Scan on Start | off |
| Hourly Scan (Find new) | off |
| Folder Watch | off |

Folder Watch and the automatic scans stay off so nothing starts converting by itself. You decide
when a season gets converted.

### Step 3. Check the flow

Open the **Transcode Options** tab. **Flows** should be selected, and the dropdown should show
the flow from Part 1. **View Flow** opens it if you want to look at the steps.

### Step 4. Start

Press the **Options** button under the list of libraries (next to **Upload**, not the one beside **Library +**) and choose **Scan (Find new)**.

Do not choose **Scan (Fresh)**. That wipes the library's records and scans everything again from
nothing.

The episodes appear in the **Transcode Queue** tab on the Home page, and the node picks up the
first one within a few seconds.

### Step 5. Wait, and keep an eye on it

On the **Home** page:

- **Nodes** shows the episode being encoded right now, its percentage and its ETA.
- **Transcode Queue** counts down as episodes are picked up.
- **Transcode: Success/Not Required** counts up as they finish.
- **Transcode: Error/Cancelled** should stay at 0.

A 45-minute 1080p episode takes about **9-10 minutes**. A 20-episode season takes about
**3 hours**. Keep the desktop awake that whole time. If Windows goes to sleep, the job stops.

### Step 6. Check the results

When the queue reaches 0, open **Transcode: Success/Not Required** and look at the sizes. Each
episode should be roughly 10-20% of what it was.

If a file is still its original size, see
[A file finished but did not get smaller](#a-file-finished-but-did-not-get-smaller).

### Step 7. Tell Sonarr

Sonarr still remembers the old file sizes. Open the show in Sonarr and press **Refresh & Scan**
at the top of the page. Sonarr re-reads the folder and picks up the new sizes.

Jellyfin notices the changed files on its next library scan. Nothing needs doing there.

---

## When something goes wrong

### Nothing starts

Check these in order:

1. Is the desktop on and awake?
2. Is the Tdarr tray icon running? See
   [the checklist](#1-the-desktop-is-on-and-the-node-is-running).
3. Does the Home page show `aborii-pc` under **Nodes**?
4. Is **Pause all nodes** switched off?
5. On the library's **Source** tab, are **Process Library** and **Transcodes** on?

### Tdarr says it cannot find the file

The job fails within a second, with *"FFprobe could not scan the file"* or *"no such file or
directory"* in the node log.

**Why it happens:** the file was created on the Pi directly, not through the `T:` share. Windows
remembers what is in each shared folder, and a file added from the Pi's side does not always
update what Windows remembers. So the desktop, and the node on it, cannot see the file, even
though it is really there.

**How to fix it:**

1. In Windows Explorer, open that folder on `T:`.
2. Create any new file in it, then delete it. This makes Windows look at the folder again.
3. Put it back in the queue. On the **Libraries** page, select the library, press the **Options** button under the list of libraries (next to **Upload**) and choose **Requeue all items (transcode)**. This puts every file in that library back in the queue, but it is safe: episodes that were already converted are HEVC now, so step 2 of the flow skips them without touching them.

Episodes that Sonarr imported a while ago are not affected. This only happens with files added in
the last few minutes.

### A file finished but did not get smaller

It shows as finished in Tdarr, but its size did not change. There are two
possible reasons, and in both the original is safe:

- **It was not H.264.** It was probably already HEVC, so step 2 of the flow skipped it on
  purpose.
- **The new file failed the size check.** It came out smaller than 5% or bigger than 40% of the
  original, so step 8 threw it away and kept the original.

### A converted file is bigger than expected

The show's audio is probably not EAC3. Some releases use AC3, DTS or TrueHD, and step 6 only
removes EAC3, so the big surround track stays in.

To fix it, open **Remove Stream By Property** in the flow and change
Values To Remove to:

```
eac3,ac3,dts,truehd
```

### An old error is still showing

Tdarr keeps failed jobs in **Transcode: Error/Cancelled**, even after a retry has worked. Check
the time on the error. If it is from before the retry, it is old and can be ignored.

---

## Never do these

- **Never use this flow on shows without English audio**, such as anime. Step 5 builds the new
  audio from the English (or untagged) track. If there is none, it adds nothing, and step 6 then
  removes the only audio track. You get a silent file.
- **Never turn on Folder Watch for the main Media library.** Something on the Pi keeps changing
  file timestamps, and Folder Watch treats that as a new file and starts converting unrelated
  films.
- **Never convert files that are still seeding** if the point is to save space. While
  qBittorrent is seeding, the downloaded copy stays on disk next to the converted one, so no space
  is freed. Wait until the torrent is gone.
- **Never update Tdarr on only one machine.** See
  [the checklist](#4-do-not-click-the-tdarr-update).

---

## There is no undo

**Replace Original File** deletes the original. Once an episode is converted, the only way back
to the big version is to download it again through Sonarr. That is what Part 2 is for.

---

## Reference

| Thing | Value |
|---|---|
| Tdarr web page | <http://aboriis-pi:8265> |
| Port the node talks to | `8266` |
| Node install folder | `C:\Tdarr\Tdarr_Node` |
| Node settings file | `C:\Tdarr\configs\Tdarr_Node_Config.json` |
| Node log | `C:\Tdarr\logs\Tdarr_Node_Log.txt` |
| Library for converting seasons | **H50 S07 HEVC 1080p** |
| Library for tests | **H50 720p test**, folder `/media/_tdarr-test` |
| Main library, never convert from here | **Media**, folder `/media` |
| Cache folder | `/temp`, which is `T:\media\tdarr-cache` |

### If the node is ever reinstalled

The node settings file needs these path translators, or the node will not find any files:

```json
"pathTranslators": [
  { "server": "/media", "node": "T:/media/library" },
  { "server": "/temp",  "node": "T:/media/tdarr-cache" }
]
```

It also needs `"nodeType": "mapped"`, `"serverPort": "8266"`, and `serverIP` set to the Pi's
address.

The node's version must match the server's. The version is shown at the top of the Tdarr web
page.
