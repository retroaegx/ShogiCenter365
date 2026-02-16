#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cleanup_unused_files.py

Purpose
  Remove generated / unused artifacts inside backend/ and frontend/.

Default behavior is dry-run (no deletions) to avoid accidental data loss.

Run
  # Dry-run (default)
  python3 cleanup_unused_files.py

  # Actually delete
  python3 cleanup_unused_files.py --apply

Notes
  - This script only touches paths under this repo root.
  - It is safe to run repeatedly.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path
from typing import Iterable, List, Set, Tuple


# --- Explicitly unused / generated targets (repo-relative paths) ---
# Backend
BACKEND_DELETE_PATHS = [
    "backend/tools/apply_ws_emit_patch.py",
    "backend/README_ADD_TO_MAIN.md",

    "backend/src/main.py.add-index-waiting-rooms.txt",
    "backend/src/main.py.add-this.txt",
    "backend/src/main.py.add-db-handles.txt",

    "backend/src/routes/game.py.patch",
    "backend/src/routes/lobby_presence.py",
    "backend/src/routes/lobby_online.py",
    "backend/src/routes/auth_contract_example.py",
    "backend/src/routes/offer_events.py",

    "backend/src/services/game_service.py.patch",
    "backend/src/services/game_service_append_as_api_payload.py",
    "backend/src/services/auth_service.py",
    "backend/src/services/rating_service.py",
    "backend/src/services/time_service.py",

    "backend/src/models/database.py.patch",

    "backend/src/utils/async_utils.py",
    "backend/src/utils/websocket_manager.join_leave.fixed.pyfrag",

    "backend/src/snippets/main_binding_patch.py",
]

# Frontend (src)
FRONTEND_UNUSED_SRC_FILES = [
    "frontend/shogi-frontend/src/components/game/ResultDialog.jsx",
    "frontend/shogi-frontend/src/components/game/TimerPill.jsx",
    "frontend/shogi-frontend/src/components/home/HomeShogi.jsx",
    "frontend/shogi-frontend/src/components/lobby/InviteLinkModal.jsx",
    "frontend/shogi-frontend/src/components/lobby/OfferOverlays.jsx",
    "frontend/shogi-frontend/src/components/lobby/SideLobbyUserList.jsx",
    "frontend/shogi-frontend/src/components/top/LanguagePicker.jsx",

    # Unused shadcn/ui components
    "frontend/shogi-frontend/src/components/ui/accordion.jsx",
    "frontend/shogi-frontend/src/components/ui/aspect-ratio.jsx",
    "frontend/shogi-frontend/src/components/ui/avatar.jsx",
    "frontend/shogi-frontend/src/components/ui/breadcrumb.jsx",
    "frontend/shogi-frontend/src/components/ui/bubble-rise-button.jsx",
    "frontend/shogi-frontend/src/components/ui/carousel.jsx",
    "frontend/shogi-frontend/src/components/ui/chart.jsx",
    "frontend/shogi-frontend/src/components/ui/collapsible.jsx",
    "frontend/shogi-frontend/src/components/ui/command.jsx",
    "frontend/shogi-frontend/src/components/ui/context-menu.jsx",
    "frontend/shogi-frontend/src/components/ui/drawer.jsx",
    "frontend/shogi-frontend/src/components/ui/dropdown-menu.jsx",
    "frontend/shogi-frontend/src/components/ui/form.jsx",
    "frontend/shogi-frontend/src/components/ui/glass-draw-action-button.jsx",
    "frontend/shogi-frontend/src/components/ui/input-otp.jsx",
    "frontend/shogi-frontend/src/components/ui/menubar.jsx",
    "frontend/shogi-frontend/src/components/ui/navigation-menu.jsx",
    "frontend/shogi-frontend/src/components/ui/pagination.jsx",
    "frontend/shogi-frontend/src/components/ui/progress.jsx",
    "frontend/shogi-frontend/src/components/ui/radio-group.jsx",
    "frontend/shogi-frontend/src/components/ui/resizable.jsx",
    "frontend/shogi-frontend/src/components/ui/separator.jsx",
    "frontend/shogi-frontend/src/components/ui/sheet.jsx",
    "frontend/shogi-frontend/src/components/ui/sidebar.jsx",
    "frontend/shogi-frontend/src/components/ui/skeleton.jsx",
    "frontend/shogi-frontend/src/components/ui/sonner.jsx",
    "frontend/shogi-frontend/src/components/ui/table.jsx",
    "frontend/shogi-frontend/src/components/ui/textarea.jsx",
    "frontend/shogi-frontend/src/components/ui/toggle-group.jsx",
    "frontend/shogi-frontend/src/components/ui/toggle.jsx",
    "frontend/shogi-frontend/src/components/ui/tooltip.jsx",

    # Unused config/hooks/lib/services/utils
    "frontend/shogi-frontend/src/config/apiNaming.js",
    "frontend/shogi-frontend/src/config/touchConfig.js",
    "frontend/shogi-frontend/src/hooks/use-mobile.js",
    "frontend/shogi-frontend/src/hooks/useLobbyOfferEventsStable.js",
    "frontend/shogi-frontend/src/i18n/extraKeys.js",
    "frontend/shogi-frontend/src/i18n/shogiErrors.js",
    "frontend/shogi-frontend/src/lib/rules.js",
    "frontend/shogi-frontend/src/lib/socket.js",
    "frontend/shogi-frontend/src/lib/socket.ts",
    "frontend/shogi-frontend/src/services/env.js",
    "frontend/shogi-frontend/src/services/fetchAuthPatch.js",
    "frontend/shogi-frontend/src/services/socket_handlers.ts",
    "frontend/shogi-frontend/src/utils/layoutProbe.js",
    "frontend/shogi-frontend/src/utils/shogiCoords.js",
    "frontend/shogi-frontend/src/utils/shogi_rule_utils.ts",
    "frontend/shogi-frontend/src/utils/time.js",
    "frontend/shogi-frontend/src/utils/username_guard.example.js",
]

# Frontend (generated / duplicates)
FRONTEND_DELETE_DIRS = [
    "frontend/shogi-frontend/node_modules",
    "frontend/shogi-frontend/dist",
    "frontend/shogi-frontend/public/assets",
]

# Keep only the flags actually referenced by the app/static shell.
# (language flags + LEGION_DEFS)
COUNTRY_FLAGS_KEEP = {
    # UI languages
    "jp", "us", "cn", "fr", "de", "pl", "it", "pt",
    # Legions
    "gb", "kr", "tw", "hk", "sg", "th", "vn", "id", "ph", "in",
    "au", "ca", "br", "mx", "ru", "tr", "sa", "ae", "nl", "se",
    "no", "fi", "ua", "es",
}
COUNTRY_FLAGS_DIR = "frontend/shogi-frontend/public/country"


def _is_under_root(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False


def _delete_file(p: Path) -> None:
    p.unlink()


def _delete_dir(p: Path) -> None:
    shutil.rmtree(p)


def _collect_backend_caches(repo_root: Path) -> List[Path]:
    """Collect __pycache__ dirs and *.pyc under backend/."""
    backend = repo_root / "backend"
    if not backend.exists():
        return []

    targets: List[Path] = []

    # __pycache__ dirs
    for d in backend.rglob("__pycache__"):
        if d.is_dir():
            targets.append(d)

    # *.pyc
    for f in backend.rglob("*.pyc"):
        if f.is_file():
            targets.append(f)

    # De-dup, sort
    uniq = []
    seen = set()
    for t in sorted(targets, key=lambda x: str(x)):
        k = str(t)
        if k in seen:
            continue
        seen.add(k)
        uniq.append(t)
    return uniq


def _collect_country_flags_to_delete(repo_root: Path) -> List[Path]:
    country_dir = repo_root / COUNTRY_FLAGS_DIR
    if not country_dir.exists() or not country_dir.is_dir():
        return []

    targets: List[Path] = []
    for f in country_dir.glob("*.svg"):
        stem = f.stem.lower()
        if stem not in COUNTRY_FLAGS_KEEP:
            targets.append(f)

    return sorted(targets, key=lambda x: str(x))


def _rmdir_if_empty(d: Path) -> bool:
    try:
        if d.exists() and d.is_dir() and not any(d.iterdir()):
            d.rmdir()
            return True
    except Exception:
        pass
    return False


def _prune_empty_dirs(repo_root: Path) -> List[Path]:
    """Prune a few known directories that may become empty after deletions."""
    candidates = [
        repo_root / "frontend/shogi-frontend/src/components/home",
    ]
    removed: List[Path] = []
    for d in candidates:
        if _rmdir_if_empty(d):
            removed.append(d)
    return removed


def _build_targets(repo_root: Path) -> Tuple[List[Path], List[Path]]:
    files: List[Path] = []
    dirs: List[Path] = []

    for rel in BACKEND_DELETE_PATHS + FRONTEND_UNUSED_SRC_FILES:
        p = repo_root / rel
        files.append(p)

    for rel in FRONTEND_DELETE_DIRS:
        dirs.append(repo_root / rel)

    # Dynamic backend caches
    for p in _collect_backend_caches(repo_root):
        # __pycache__ is a directory, *.pyc is a file
        (dirs if p.is_dir() else files).append(p)

    # Trim public/country flags
    for p in _collect_country_flags_to_delete(repo_root):
        files.append(p)

    # De-dup and sort
    def dedup(items: Iterable[Path]) -> List[Path]:
        out: List[Path] = []
        seen: Set[str] = set()
        for x in sorted(items, key=lambda x: str(x)):
            k = str(x)
            if k in seen:
                continue
            seen.add(k)
            out.append(x)
        return out

    return dedup(files), dedup(dirs)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Actually delete files (otherwise dry-run).")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parent

    file_targets, dir_targets = _build_targets(repo_root)

    # Filter to safe paths only
    file_targets = [p for p in file_targets if _is_under_root(repo_root, p)]
    dir_targets = [p for p in dir_targets if _is_under_root(repo_root, p)]

    print("[cleanup] repo_root:", repo_root)
    print("[cleanup] mode:", "APPLY" if args.apply else "DRY-RUN")
    print("[cleanup] targets:")

    missing: List[Path] = []
    planned: List[Path] = []

    for p in dir_targets + file_targets:
        if not p.exists():
            missing.append(p)
            continue
        planned.append(p)
        kind = "DIR " if p.is_dir() else "FILE"
        print(f"  - {kind}: {p.relative_to(repo_root)}")

    if missing:
        print("[cleanup] (info) missing targets (already gone?):")
        for p in missing:
            print("  -", p.relative_to(repo_root) if _is_under_root(repo_root, p) else str(p))

    if not args.apply:
        print("[cleanup] dry-run done. Re-run with --apply to delete.")
        return 0

    # Delete dirs first (bigger cleanup)
    deleted: List[Path] = []
    errors: List[Tuple[Path, str]] = []

    for d in dir_targets:
        try:
            if d.exists() and d.is_dir():
                _delete_dir(d)
                deleted.append(d)
        except Exception as e:
            errors.append((d, str(e)))

    for f in file_targets:
        try:
            if f.exists() and f.is_file():
                _delete_file(f)
                deleted.append(f)
        except Exception as e:
            errors.append((f, str(e)))

    # Prune some empty dirs
    pruned = _prune_empty_dirs(repo_root)
    deleted.extend(pruned)

    print(f"[cleanup] deleted: {len(deleted)}")
    if errors:
        print("[cleanup] errors:")
        for p, msg in errors:
            rel = p.relative_to(repo_root) if _is_under_root(repo_root, p) else str(p)
            print(f"  - {rel}: {msg}")
        return 1

    print("[cleanup] done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
