import io, re, shutil, os

LIVE = "/srv/storage/appdata/homepage"
EX   = "/home/aborii/media-stack/examples/homepage"

# Secrets never leave the Pi. Anything that looks like a credential is replaced
# with a placeholder before the file is copied into the repo.
PLACEHOLDER = {
    "jellyfin":  "PASTE_JELLYFIN_API_KEY",
    "immich":    "PASTE_IMMICH_API_KEY",
    "portainer": "PASTE_PORTAINER_TOKEN",
}

def redact(text):
    out, current = [], None
    for line in text.splitlines():
        m = re.match(r"^\s*type:\s*(\w+)", line)
        if m:
            current = m.group(1).lower()
        if re.match(r"^\s*key:\s*\S", line) and "PASTE_" not in line:
            ph = PLACEHOLDER.get(current, "PASTE_API_KEY")
            line = re.sub(r"(key:\s*).*", r"\1" + ph, line)
        elif re.match(r"^\s*password:\s*\S", line) and "PASTE_" not in line:
            line = re.sub(r"(password:\s*).*", r"\1PASTE_PASSWORD", line)
        out.append(line)
    return "\n".join(out) + "\n"

for name in ("services", "settings", "widgets", "bookmarks"):
    src = os.path.join(LIVE, name + ".yaml")
    dst = os.path.join(EX,   name + ".yaml")
    text = io.open(src, encoding="utf-8").read()
    if name in ("services", "settings"):
        text = redact(text)
    io.open(dst, "w", encoding="utf-8", newline="\n").write(text)
    print("  synced %s.yaml" % name)

# Prove nothing leaked: search the examples for every live secret value.
secrets = set()
for line in io.open(os.path.join(LIVE, "services.yaml"), encoding="utf-8"):
    m = re.match(r"^\s*(?:key|password):\s*(\S+)", line)
    if m and not m.group(1).startswith("PASTE_"):
        secrets.add(m.group(1).strip('"'))
leaked = []
for name in ("services", "settings", "widgets", "bookmarks"):
    body = io.open(os.path.join(EX, name + ".yaml"), encoding="utf-8").read()
    for sec in secrets:
        if sec and sec in body:
            leaked.append((name, sec[:8] + "..."))
print()
print("  live secrets found: %d" % len(secrets))
print("  leaked into examples: %s" % (leaked if leaked else "NONE"))
assert not leaked, "SECRET LEAKED - aborting"
