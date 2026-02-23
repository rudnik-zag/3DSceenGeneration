#!/usr/bin/env python3
import json
import os
import sys
import zipfile

try:
    import rarfile  # pip install rarfile
except Exception:
    rarfile = None


def _safe_join(root, member_name):
    # Prevent zip slip / path traversal.
    target = os.path.normpath(os.path.join(root, member_name))
    root_norm = os.path.normpath(root)
    if os.path.commonpath([root_norm, target]) != root_norm:
        raise ValueError(f"Unsafe path detected: {member_name}")
    return target


def _extract_zip(path, target_dir):
    extracted = []
    with zipfile.ZipFile(path, "r") as zf:
        for member in zf.infolist():
            if member.is_dir():
                continue
            out_path = _safe_join(target_dir, member.filename)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            with zf.open(member, "r") as src, open(out_path, "wb") as dst:
                dst.write(src.read())
            extracted.append(out_path)
    return extracted


def _extract_rar(path, target_dir):
    if rarfile is None:
        raise RuntimeError("rarfile not installed (pip install rarfile) or backend missing")
    extracted = []
    with rarfile.RarFile(path) as rf:
        for member in rf.infolist():
            if member.isdir():
                continue
            out_path = _safe_join(target_dir, member.filename)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            with rf.open(member) as src, open(out_path, "wb") as dst:
                dst.write(src.read())
            extracted.append(out_path)
    return extracted


def unpack_archives(root_dir, output_json):
    extracted_paths = []

    for dirpath, _, filenames in os.walk(root_dir):
        for name in filenames:
            lower = name.lower()
            if not (lower.endswith(".zip") or lower.endswith(".rar")):
                continue

            archive_path = os.path.join(dirpath, name)
            target_dir = os.path.splitext(archive_path)[0]

            if os.path.isdir(target_dir):
                print(f"Skip (target exists): {archive_path}")
                continue

            try:
                os.makedirs(target_dir, exist_ok=True)
                if lower.endswith(".zip"):
                    _extract_zip(archive_path, target_dir)
                else:
                    _extract_rar(archive_path, target_dir)
                extracted_paths.append(target_dir)
                print(f"Extracted: {archive_path}")
            except Exception as exc:
                print(f"Failed: {archive_path} -> {exc}")
                # Best effort cleanup if we created an empty dir
                try:
                    if os.path.isdir(target_dir) and not os.listdir(target_dir):
                        os.rmdir(target_dir)
                except Exception:
                    pass
                continue

    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(extracted_paths, f, indent=2)


def main():
    if len(sys.argv) != 2:
        print("Usage: python utils/unpack_archives.py /path/to/root_dir")
        sys.exit(1)

    root_dir = sys.argv[1]
    if not os.path.isdir(root_dir):
        print(f"Error: not a directory: {root_dir}")
        sys.exit(1)

    output_json = os.path.join(root_dir, "extracted_files.json")
    unpack_archives(root_dir, output_json)
    print(f"Wrote: {output_json}")


if __name__ == "__main__":
    main()
