# Paperless

Day-to-day use of the document archive. How each part works, and why, is in
the comments of `compose.yaml` and at the top of `scripts/after-ai.py`.

## What happens to a document

1. **It arrives.** An upload, the inbox folder, or the Gmail label
   `Paperless`. Gmail is checked every 10 minutes, on the mini, whether the
   PC is on or not.
2. **Paperless files it.** It runs its own OCR (English and Arabic), and
   `scripts/after-filing.py` unlocks a locked PDF with your password list.
   The document is tagged `ai-new`. From here it is searchable, even before
   the AI touches it.
3. **The AI reads it** (`ai-new` → `ai-read`). This only happens while the
   PC is on and the AI is not paused. Until then the document simply waits.
4. **after-AI cleans the text** and passes it on (`ai-read` → `ai-name`).
   It runs every 2 minutes.
5. **The AI names it**: title, tags, correspondent, type and bill fields.
   When it is done, the document gets `paperless-gpt-auto-complete`.
6. **after-AI fixes what a rule can catch:** dates, language, bank names,
   tags. It also fills the mail fields.

## Tags you will see

| Tag | Means |
| --- | --- |
| `ai-new`, `ai-read`, `ai-name` | Still with the AI. Leave it alone. |
| `paperless-gpt-auto-complete` | Named. Done. |
| `paperless-gpt-failed` | The AI could not read it. See below. |
| complete **and** failed | Named, but Paperless refused one value. See below. |
| `locked` | No password in your list opens it. The AI skips it. |
| `unlocked` | Opened with your list. The original is kept as version 1. |
| `gmail` | Came in by email. |
| `translation` | A translation, or an original with its translation. |

## Fields

- **Total amount, Due date, Invoice number:** filled by the AI on bills.
- **Languages:** filled by code from the text.
- **Related documents:** set by you, for example to link an original and its translation.
- **Sent by, Sent on, Recipient:** filled on emailed documents. They hold the sender, the time it was sent (Dubai time), and the mailbox it came to.

## Notes on a document

A note starting with `after-ai:` says what after-AI changed and why: a
removed date, a corrected language, a bank tag taken off, and so on. Each fix
runs once per document. If you change something by hand after that, your
change stays.

## Common tasks

### Run the AI again on a document

After a prompt change, or when a name came out wrong:

```bash
ssh mini docker exec -u paperless paperless python3 /usr/src/paperless/scripts/rerun-ai.py 32 36
```

Put the document ids at the end. This resets the title to the file name and
clears the AI's tags, correspondent, type and bill fields. It keeps `locked`,
`unlocked`, `gmail`, and your Languages and Related documents. Tags you added
by hand are removed, so add them back afterwards. Always run it with
`-u paperless`; it refuses to run as root.

### A document is tagged `paperless-gpt-failed`

The AI could not read a page. Usually the model got stuck repeating a
watermark, and Ollama stopped it. after-AI then names the document once from
Paperless's own OCR, and leaves a note saying so. The name may be weaker than
usual. To try the AI again, run it again (above).

### A document is tagged both complete and failed

The AI named it, but Paperless refused one value. This is almost always the
correspondent: the AI added a note to its answer, so the "name" was too long.

1. Set the correspondent by hand.
2. Remove the `paperless-gpt-failed` tag.

### A PDF is locked

1. Add its password to `/srv/appdata/paperless/secrets/pdf-passwords.txt` on the mini, one password per line:

   ```bash
   ssh -t mini nano /srv/appdata/paperless/secrets/pdf-passwords.txt
   ```

2. **New PDFs** unlock on their own from then on.
3. **One already in Paperless:**
   1. Open it.
   2. Go to **Actions → Remove password** and type the password.
   3. Tick **Update document**.

   That keeps the locked original as version 1 and adds the unlocked copy as version 2. Without the tick, Paperless makes a separate document instead.

### A bank shows up under two names

Statements are filed under the bank their title names. Names that differ only
in case, spacing, or words like "Bank", "PJSC" or "LLC" already count as the
same bank. Short names and brands do not, for example "AMCB", "Mbank" or
"Jumeirah Pay".

1. Merge the existing documents into one correspondent in Paperless.
2. Add the short name to `BANK_ALIASES` in `scripts/after-ai.py`, through a PR. The key is the name in lowercase letters only, with a trailing "bank" removed. The value is the key of the bank to keep. For example, `"mbank"` becomes `"m": "almaryahcommunity"`.

Empty correspondents that are an email address, or another spelling of an
existing one, are deleted by after-AI on its own. Any others are left alone.

### Gmail

- **Which emails come in:** anything with the Gmail label `Paperless`. Your Gmail filters decide that, so the sender list is changed in Gmail.
- **The label must be visible to IMAP:** in Gmail, Settings → Labels → `Paperless`, tick **Show in IMAP**.
- **Filed emails** get the Gmail label `Paperless-filed`. Paperless skips those next time.
- **Skipped emails:** Paperless remembers every email it has looked at. One it skipped stays skipped until its record is deleted in Paperless's processed-mail list.
- **A big import:** let it finish being filed before fetching again by hand. Running two fetches at once filed every email twice once.

### Pause the AI

Use the AI icon in the PC's tray, or `pc/ollama/pause.ps1`; see
`pc/ollama/README.md`. While paused, documents wait with `ai-new` and carry on
once you resume.

### Delete documents and upload them again

Paperless refuses a file it already has, including one in the trash. Empty
the trash first.

### Change a prompt

The prompts live in `paperless-gpt/workflows/`. After a change is merged, copy
them to the mini:

```bash
ssh mini 'cd ~/media-stack/stacks/paperless && rsync -a --delete paperless-gpt/workflows/ /srv/appdata/paperless-gpt/prompts/workflows/'
```

paperless-gpt picks up the change without a restart. To apply it to existing
documents, run the AI on them again.

## Where things are

| What | Where |
| --- | --- |
| Settings and how it works | `compose.yaml` |
| The fixes after the AI | `scripts/after-ai.py`, every 2 minutes (`systemd/paperless-after-ai.*`) |
| Unlocking on arrival | `scripts/after-filing.py` |
| The AI's prompts | `paperless-gpt/workflows/` |
| PDF passwords | `/srv/appdata/paperless/secrets/pdf-passwords.txt` on the mini |
| Nightly copy of the library | `/srv/storage/data/paperless-library/` (`scripts/paperless-library-sync.sh`, 03:30) |
| The AI on the PC | `pc/ollama/` |
| Start and stop of paperless-gpt | `scripts/paperless-gpt-gate.sh`; it runs only while the PC's Ollama answers |
