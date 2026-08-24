# TODO

## Tdarr node on the Windows desktop

The Tdarr **server** runs on the Pi already and holds the queue, but nothing
encodes until a node exists. The Pi deliberately does not encode
(`internalNode=false`) — it has no hardware video encoder.

**Why this matters.** Live transcoding at playback is the only case where the
Pi's missing encoder genuinely hurts, and it is the one path that cannot be
deferred to another machine. Normalising the library ahead of time means
Jellyfin direct plays instead, so the Pi only moves bytes.

**Setup**

- [ ] Install the Tdarr Node package for Windows on the desktop
- [ ] Point it at the Pi: `192.168.0.143`, server port `8266`
- [ ] Enable NVENC (RTX 3080 Ti) as the encoder
- [ ] Map the Samba share so the node can reach the media

**Path translation — the usual failure**

The two machines see the same files by different paths:

| | |
|---|---|
| Pi (server) | `/media/tv` |
| Desktop (node) | `\192.168.0.143\storage\media\library\tv` |

Tdarr has a path-translation setting for this. Getting it wrong means the node
accepts jobs and fails every one, which looks like a broken node rather than a
config problem.

**Be careful before pointing it at 2.7 TB**

- [ ] Test on a small library first — a handful of files, not the real one
- [ ] Check the output quality before trusting a plugin
- [ ] Decide whether to keep originals until verified

Tdarr **replaces files in place**. A wrong plugin setting can re-encode the whole
collection at the wrong quality and there is no undo.

**Open questions**

- Which target format? H.264 is the safest for direct play; HEVC saves space but
  some clients cannot decode it, which would reintroduce transcoding.
- Only convert files that actually cause transcodes, or normalise everything?
- Behaviour when the desktop is off for long stretches — queue depth is fine,
  but a partially converted library means mixed formats for a while.

## Also outstanding

- [ ] Delete `immich/model-cache` (786 MB) and the `Backups` folders (~680 MB)
      copied unnecessarily — Immich re-downloads its models, and the dumps are of
      databases that came across live.
- [ ] Narrow `HOMEPAGE_ALLOWED_HOSTS` from `*` to the Pi's address once settled.
- [ ] Write the Homepage dashboard config — services behind the VPN are reached
      at `gluetun:<port>`, everything else by container name.
- [ ] Decide whether Bazarr needs to move behind the VPN, if subtitle providers
      turn out to be blocked.
