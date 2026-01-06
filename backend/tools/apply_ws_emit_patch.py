
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # backend/
TARGET = ROOT / "src/routes/lobby.py"

def ensure_imports(txt):
    if "from src.routes.offer_events import emit_offer_created, emit_offer_status" in txt:
        return txt, False
    # insert after first block of imports
    lines = txt.splitlines(True)
    insert_at = 0
    for i, line in enumerate(lines[:50]):
        if line.startswith("import ") or line.startswith("from "):
            insert_at = i+1
    lines.insert(insert_at, "from src.routes.offer_events import emit_offer_created, emit_offer_status\n")
    return "".join(lines), True

def insert_before_return(txt, func_name, marker_regex, emit_line):
    m = re.search(rf"def\s+{func_name}\s*\(", txt)
    if not m: return txt, False
    start = m.start()
    # find block end
    block_end = len(txt)
    m2 = re.search(r"\n(def |@)", txt[start+1:])
    if m2: block_end = start+1+m2.start()
    block = txt[start:block_end]
    # find 'return _json({'success': True ...' most late occurrence
    ret = None
    for m3 in re.finditer(r"\n\s*return\s+_json\(\{'success':\s*True", block):
        ret = m3
    if not ret:
        ret = re.search(r"\n\s*return\s+_json\(", block)
    if not ret: return txt, False
    # compute indentation from return line
    ret_line = block[ret.start()+1:block.find("\n", ret.start()+1)]
    indent = " " * (len(ret_line) - len(ret_line.lstrip(" ")))
    ins = "\n" + indent + emit_line + "\n"
    new_block = block[:ret.start()] + ins + block[ret.start():]
    return txt[:start] + new_block + txt[block_end:], True

def main():
    if not TARGET.exists():
        print("not found:", TARGET, file=sys.stderr); sys.exit(1)
    txt = TARGET.read_text(encoding="utf-8")

    changed = False
    txt, ch = ensure_imports(txt); changed |= ch

    # join-by-user -> offer_created
    txt, ch = insert_before_return(txt, "join_by_user",
                                   r"update_one",
                                   "emit_offer_created(to_user_id=opp, from_user={'_id': str(me), 'name': (me_doc or {}).get('name') if 'me_doc' in locals() else None}, time_minutes=(body or {}).get('minutes') or (body or {}).get('time') or (body or {}).get('time_control') or 0)")
    changed |= ch

    # accept / decline
    txt, ch = insert_before_return(txt, "offer_accept", r"update_one",
                                   "emit_offer_status(to_user_id=me, from_user_id=from_uid, status='accepted')")
    changed |= ch
    txt, ch = insert_before_return(txt, "offer_decline", r"update_one",
                                   "emit_offer_status(to_user_id=me, from_user_id=None, status='declined')")
    changed |= ch

    # waiting start/stop -> users updated
    for fn in ("waiting_start", "waiting_stop"):
        txt, ch2 = insert_before_return(txt, fn, r"update_one",
                                        "emit_offer_status(to_user_id=None, from_user_id=None, status='users_updated')")
        changed |= ch2

    if changed:
        TARGET.write_text(txt, encoding="utf-8")
        print("patched", TARGET)
    else:
        print("no changes applied")

if __name__ == "__main__":
    main()
