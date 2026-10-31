#!/usr/bin/env python3
"""Hands documents back to paperless-gpt as if they had just arrived, after a
prompt changes. Run inside the paperless container, with document ids:

    docker exec paperless python3 /usr/src/paperless/scripts/rerun-ai.py 32 36

Tagging a document "ai-new" by hand is not enough. paperless-gpt gives the
model the current title as a hint, and on a re-run that is the old AI title:
the model copied it, so a school certificate kept "Experience Certificate"
and an English letter kept "(Arabic)" though the new prompt gets both right
from the file name. paperless-gpt also adds tags and custom field values
rather than replacing them, so old ones would stay beside the new.

So for each document this puts the title back to the file name, removes every
tag except "locked" and "unlocked" (which after-filing.py set from the file,
not the AI), clears the correspondent, document type and the AI's custom
fields, and tags it "ai-new". "Languages" and "Related documents" are kept:
code and the owner fill those, not the AI. Tags the owner added by hand go
too, so add them back afterwards.
"""

import os
import sys
from pathlib import Path

AI_TAG = "ai-new"
KEEP_TAGS = {"locked", "unlocked"}
AI_FIELDS = ["Total amount", "Due date", "Invoice number"]


def main(ids: list[int]) -> None:
    sys.path.insert(0, "/usr/src/paperless/src")
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "paperless.settings")
    import django

    django.setup()
    from documents.models import CustomFieldInstance, Document, Tag

    ai_tag = Tag.objects.get(name=AI_TAG)
    for pk in ids:
        doc = Document.objects.filter(pk=pk, root_document__isnull=True).first()
        if doc is None:
            print(f"rerun-ai: document {pk}: not found (or it is a version, not a document).")
            continue
        old = doc.title
        doc.title = Path(doc.original_filename or doc.title).stem
        doc.correspondent = None
        doc.document_type = None
        doc.save(update_fields=["title", "correspondent", "document_type"])
        doc.tags.set([t for t in doc.tags.all() if t.name in KEEP_TAGS] + [ai_tag])
        CustomFieldInstance.objects.filter(document=doc, field__name__in=AI_FIELDS).delete()
        print(f"rerun-ai: document {pk}: {old!r} -> {doc.title!r}, tagged {AI_TAG}.")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or not all(a.isdigit() for a in args):
        sys.exit("usage: rerun-ai.py <document id> [<document id> ...]")
    main([int(a) for a in args])
