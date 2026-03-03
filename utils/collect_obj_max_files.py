#!/usr/bin/env python3
import json
import os
import sys


def _class_name(root_dir, dirpath):
    rel = os.path.relpath(dirpath, root_dir)
    if rel == ".":
        return "__root__"
    return rel.split(os.sep, 1)[0]


def collect_obj_max(root_dir):
    results_by_class = {}
    stats = {"dirs_checked": 0, "obj_files": 0, "max_files": 0, "fbx_files": 0, "classes": 0}
    class_stats = {}

    for dirpath, _, filenames in os.walk(root_dir):
        obj_files = []
        max_files = []
        fbx_files = []

        for name in filenames:
            lower = name.lower()
            if lower.endswith(".obj"):
                obj_files.append(os.path.join(dirpath, name))
            elif lower.endswith(".max"):
                max_files.append(os.path.join(dirpath, name))
            elif lower.endswith(".fbx"):
                fbx_files.append(os.path.join(dirpath, name))

        if obj_files or max_files or fbx_files:
            stats["dirs_checked"] += 1
            class_name = _class_name(root_dir, dirpath)
            results_by_class.setdefault(class_name, []).append(
                {
                    "dir": dirpath,
                    "obj_files": sorted(obj_files),
                    "max_files": sorted(max_files),
                    "fbx_files": sorted(fbx_files),
                }
            )
            class_stats.setdefault(class_name, {"dirs": 0, "obj_files": 0, "max_files": 0, "fbx_files": 0})
            class_stats[class_name]["dirs"] += 1

            # If max exists, count only max. Else if fbx exists, count fbx. Else count obj.
            if max_files:
                stats["max_files"] += len(max_files)
                class_stats[class_name]["max_files"] += len(max_files)
            elif fbx_files:
                stats["fbx_files"] += len(fbx_files)
                class_stats[class_name]["fbx_files"] += len(fbx_files)
            else:
                stats["obj_files"] += len(obj_files)
                class_stats[class_name]["obj_files"] += len(obj_files)

    classes = {}
    for class_name in sorted(results_by_class.keys()):
        entries = results_by_class[class_name]
        entries.sort(key=lambda e: e["dir"])
        classes[class_name] = entries

    stats["classes"] = len(classes)
    return {"stats": stats, "class_stats": class_stats, "classes": classes}


def main():
    if len(sys.argv) not in (2, 3):
        print("Usage: python utils/collect_obj_max_files.py /path/to/root_dir [output_json]")
        sys.exit(1)

    root_dir = sys.argv[1]
    if not os.path.isdir(root_dir):
        print(f"Error: not a directory: {root_dir}")
        sys.exit(1)

    output_json = sys.argv[2] if len(sys.argv) == 3 else os.path.join(root_dir, "dataset_information.json")
    results = collect_obj_max(root_dir)

    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    print(f"Wrote: {output_json}")


if __name__ == "__main__":
    main()
