# TODO

## Tdarr node on the Windows desktop — running since 2026-09-03

The server is un-parked and the node (`aborii-pc`, RTX 3080 Ti, NVENC) is
registered as a **mapped** node with the Samba share on `T:` and translators
`/media` → `T:/media/library`, `/temp` → `T:/media/tdarr-cache`. Unmapped nodes
turned out to be Tdarr Pro only. The full write-up, including the package layout
and the credential/hostname trap, is `TDARR-NODE.md` in the pi5-nas-setup repo.

**Why this matters.** Live transcoding at playback is the only case where the
Pi's missing encoder genuinely hurts, and it is the one path that cannot be
deferred to another machine. Normalising the library ahead of time means
Jellyfin direct plays instead, so the Pi only moves bytes.

- [ ] Un-pause the Tdarr monitor in Uptime Kuma
- [ ] Empty `tdarr-cache` (1.8 GB of scratch from the first attempt)
- [ ] Pin the `tdarr` image tag, or expect the node to stop connecting whenever
      `latest` moves — server and node versions must match exactly

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
- [ ] Narrow `HOMEPAGE_ALLOWED_HOSTS` once settled — it lists every name now.
- [ ] Watch the first few nights of backup uploads. The receiver on the PC only
      catches one if the PC is on; a run of misses means the archive rotation on
      the Pi (3 kept) is too shallow for how often that machine is off.
- [ ] Decide whether Bazarr needs to move behind the VPN, if subtitle providers
      turn out to be blocked.

## Hardware note: UAS must stay disabled

The 10 TB drive is in a Ugreen enclosure with a **Realtek RTL9210** bridge
(`0bda:9201`). Under sustained write load it stops answering UAS commands, the
kernel resets it, recovery fails, and the device is offlined — ext4 then remounts
read-only and every service on `/srv/storage` dies. This happened on 2026-08-24
while Docker pulled ten images.

`dmesg` signature:

```
usb 4-1: enable of device-initiated U1 failed
scsi host0: uas_eh_device_reset_handler success
sd 0:0:0:0: Device offlined - not ready after error recovery
EXT4-fs (sdX1): Remounting filesystem read-only
```

**Applied fix:** `usb-storage.quirks=0bda:9201:u` in `/boot/firmware/cmdline.txt`,
forcing bulk-only transport instead of UAS. Costs perhaps 20-30% of sequential
throughput; buys a disk that stays online. Verify with `lsmod | grep uas`
returning nothing.

- [ ] Re-apply this after any reflash — `pi5-setup.sh` does not yet include it

**No data was lost.** The read-only remount is `errors=remount-ro` working as
intended: ext4 stopped writing the instant it saw the fault, and the journal
replayed cleanly on the next mount. All databases passed integrity checks
afterwards.

**Device names are not stable.** With the 2 TB Seagate also attached, the 10 TB
may be `sda` or `sdb` depending on enumeration order. Everything references the
UUID for this reason — never put `/dev/sdX` in fstab here.
