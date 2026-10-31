#!/usr/bin/env python3
"""Paperless post-consume script: runs once a document or a new version of one
is filed.

A PDF that asks for a password is stored as it came, untouched, so it can be
sent on exactly as received. If a password in the list opens it, Paperless's
own unlock adds an unlocked copy as version 2 of the same document. Content,
search and the AI use the latest version, so they get the readable copy; the
original stays as version 1 in the document's Versions menu. The document is
tagged "unlocked" with a note saying which password worked. If none does, it
is tagged "locked" with a note, and left out of the AI until it is unlocked.

Every other new document, and every new version (the unlocked copy above
included), is tagged "ai-new", which hands it to paperless-gpt. That is done
here rather than by a Paperless "Document Added" workflow so the locked
original never reaches the AI, and so the tags this adds are on before
paperless-gpt saves its own tag list over them.

It always exits 0: a post-consume failure marks the upload as failed in
Paperless, though the document is already stored. Problems are only logged.
"""

import os
import sys
from pathlib import Path

AI_TAG = os.environ.get("AI_TAG", "ai-new")
PASSWORDS = Path(os.environ.get("PDF_PASSWORDS_FILE", "/usr/src/paperless/secrets/pdf-passwords.txt"))


def passwords() -> list[str]:
    if not PASSWORDS.is_file():
        return []
    lines = (line.rstrip("\r\n") for line in PASSWORDS.read_text(encoding="utf-8").splitlines())
    return [line for line in lines if line and not line.startswith("#")]


def needs_password(path: str) -> bool:
    import pikepdf

    try:
        # Opens with an empty password, as any viewer would: a PDF that only
        # restricts copying or printing does, and is read normally.
        pikepdf.open(path).close()
        return False
    except pikepdf.PasswordError:
        return True


def opening_password(path: str) -> tuple[int, str] | None:
    import pikepdf

    for number, password in enumerate(passwords(), start=1):
        try:
            pikepdf.open(path, password=password).close()
            return number, password
        except pikepdf.PasswordError:
            continue
    return None


def main() -> None:
    sys.path.insert(0, "/usr/src/paperless/src")
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "paperless.settings")
    import django

    django.setup()
    from documents.bulk_edit import remove_password
    from documents.models import Document, Note, Tag

    def tag(name: str, color: str | None = None) -> Tag:
        defaults = {"matching_algorithm": 0}
        if color:
            defaults["color"] = color
        return Tag.objects.get_or_create(name=name, defaults=defaults)[0]

    doc = Document.global_objects.get(pk=int(os.environ["DOCUMENT_ID"]))
    root = doc.root_document or doc

    locked = (
        doc.root_document is None
        and doc.mime_type == "application/pdf"
        and needs_password(os.environ["DOCUMENT_SOURCE_PATH"])
    )
    if not locked:
        # A readable new version of a document tagged "locked" is the unlock
        # done by hand later (Actions > Remove password).
        stale = root.tags.filter(name="locked").first()
        if doc.root_document is not None and stale:
            root.tags.remove(stale)
            root.tags.add(tag("unlocked", "#455a64"))
            Note.objects.create(
                document=root,
                user=root.owner,
                note="Unlocked by hand. The original locked file is kept as version 1 (Versions menu).",
            )
        if AI_TAG:
            root.tags.add(tag(AI_TAG))
            print(f"after-filing: tagged document {root.pk} {AI_TAG}.")
        return

    found = opening_password(os.environ["DOCUMENT_SOURCE_PATH"])
    if found is None:
        root.tags.add(tag("locked", "#b71c1c"))
        Note.objects.create(
            document=root,
            user=root.owner,
            note=(
                f"Locked: none of the {len(passwords())} passwords in your PDF password list opens it, "
                "so it has no text and the AI skipped it. Add its password to the list, then use "
                "Actions > Remove password with \"Update document\" (a new version) to unlock it."
            ),
        )
        print(f"after-filing: document {root.pk} is locked and no password in the list opens it.")
        return

    number, password = found
    # Queues the unlocked copy as version 2; its own run of this script then
    # tags the document "ai-new".
    remove_password([root.pk], password=password, update_document=True, user=root.owner)
    root.tags.add(tag("unlocked", "#455a64"))
    Note.objects.create(
        document=root,
        user=root.owner,
        note=(
            f"Unlocked on upload with password {number} of your PDF password list. The original "
            "locked file is kept unchanged as version 1 (Versions menu); version 2 is the unlocked "
            "copy that is read, searched and named."
        ),
    )
    print(f"after-filing: document {root.pk} unlocked with password {number}; queued the unlocked copy as a new version.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - never fail an upload over this
        print(f"after-filing: {type(error).__name__}: {error}")
    sys.exit(0)
