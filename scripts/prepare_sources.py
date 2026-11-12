"""Verify the frozen input archives, back them up, and extract isolated copies."""

import argparse
import hashlib
import shutil
import stat
import tempfile
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "bg": (
        "企划设计BG平台.zip",
        "企划设计BG平台",
        "29aab52cbfd3beafefdda8fb5a6444cc1a0f001463c7e9d450b6955727254fea",
        "utf-8",
    ),
    "ai-gateway": (
        "AI网关-安装包-20261110.zip",
        "AI网关-安装包",
        "df1ab23e3b07a36293ea4858abb88c21e20404a1b695ed6b007ec9ef49fc9211",
        "gb18030",
    ),
    "experience": (
        "tiyanwork_source_20261110.zip",
        "tiyanwork_source_staging",
        "69695a633397334deb254dcd1c73df3c89b126b0cf34a5c79878a9d15977c464",
        "utf-8",
    ),
}


def verify(path, expected):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != expected:
        raise ValueError(f"SHA-256 mismatch: {path}")


def extract(archive, output, wrapper, encoding):
    seen = set()
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            name = item.filename
            if not item.flag_bits & 0x800:
                name = name.encode("cp437").decode(encoding)
            name = unicodedata.normalize("NFC", name.replace("\\", "/"))
            parts = PurePosixPath(name).parts
            if parts and (parts[0] == "__MACOSX" or parts[-1] == ".DS_Store"):
                continue
            if not parts or parts[0] != wrapper or any(
                part in ("..", ".git") or ":" in part for part in parts
            ):
                raise ValueError(f"Unexpected ZIP path: {name}")
            if stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError(f"Unexpected ZIP symlink: {name}")
            if len(parts) == 1 and name.endswith("/"):
                continue
            key = tuple(part.casefold() for part in parts[1:])
            if not key or key in seen:
                raise ValueError(f"Duplicate or invalid ZIP member: {name}")
            seen.add(key)
            target = output.joinpath(*parts[1:])
            if name.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(item) as original, target.open("xb") as extracted:
                shutil.copyfileobj(original, extracted)
            if item.external_attr >> 16 & stat.S_IXUSR:
                target.chmod(0o700)


def prepare(source_dir, workspace, requested):
    backup_dir = workspace / "backups"
    modules_dir = workspace / "modules"
    for directory in (backup_dir, modules_dir):
        directory.mkdir(parents=True, exist_ok=True)
    for module in requested:
        name, wrapper, expected, encoding = SOURCES[module]
        original = source_dir / name
        backup = backup_dir / name
        target = modules_dir / module
        if backup.exists():
            verify(backup, expected)
        else:
            with tempfile.TemporaryDirectory(dir=backup_dir) as temporary:
                copy = Path(temporary) / name
                shutil.copyfile(original, copy)
                verify(copy, expected)
                copy.replace(backup)
        backup.chmod(stat.S_IRUSR)
        if target.exists():
            print(f"{module}: backup verified; existing workspace left unchanged")
            continue
        with tempfile.TemporaryDirectory(dir=modules_dir) as temporary:
            staging = Path(temporary) / module
            staging.mkdir()
            extract(backup, staging, wrapper, encoding)
            staging.rename(target)
        print(f"{module}: backup verified; isolated copy extracted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=ROOT.parent)
    parser.add_argument("--workspace", type=Path, default=ROOT)
    parser.add_argument("--module", choices=SOURCES, action="append")
    args = parser.parse_args()
    try:
        prepare(args.source_dir, args.workspace, args.module or SOURCES)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
