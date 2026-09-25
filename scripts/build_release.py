"""Build an installable plugin source archive whose version matches a Git tag."""

import argparse
import json
import re
import subprocess
import zipfile
from pathlib import Path


PLUGIN_DIR = "astrbot_plugin_MCastrbot"
TAG_PATTERN = re.compile(r"^v(?P<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$")
EXCLUDED_PREFIXES = (".github/", "scripts/", "tests/")
EXCLUDED_FILES = {".gitignore"}


def version_from_tag(tag: str) -> str:
    match = TAG_PATTERN.fullmatch(tag)
    if not match:
        raise ValueError("发布 tag 必须是 vMAJOR.MINOR.PATCH，可附加预发布后缀，例如 v1.2.3-rc.1")
    return match.group("version")


def versioned_files(root: Path, version: str) -> dict[str, bytes]:
    metadata = (root / "metadata.yaml").read_text(encoding="utf-8")
    updated_metadata, count = re.subn(r"(?m)^version:[^\r\n]*$", f"version: {version}", metadata)
    if count != 1:
        raise ValueError("metadata.yaml 必须恰好有一个 version 字段")

    changed = {"metadata.yaml": updated_metadata.encode("utf-8")}
    for name in ("package.json", "package-lock.json"):
        payload = json.loads((root / name).read_text(encoding="utf-8"))
        payload["version"] = version
        if name == "package-lock.json":
            payload["packages"][""]["version"] = version
        changed[name] = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    return changed


def tracked_sources(root: Path) -> list[str]:
    output = subprocess.check_output(["git", "ls-files", "-z"], cwd=root)
    files = [path.decode("utf-8") for path in output.split(b"\0") if path]
    return sorted(path for path in files if path not in EXCLUDED_FILES and
                  not path.startswith(EXCLUDED_PREFIXES))


def build_archive(root: Path, tag: str, destination: Path) -> str:
    version = version_from_tag(tag)
    overrides = versioned_files(root, version)
    files = tracked_sources(root)
    if not overrides.keys() <= set(files):
        raise ValueError("版本文件必须已加入 Git")

    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in files:
            data = overrides.get(name)
            if data is None:
                data = (root / name).read_bytes()
            entry = zipfile.ZipInfo(f"{PLUGIN_DIR}/{name}", date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return version


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", help="Git tag, e.g. v1.2.3")
    parser.add_argument("--output", type=Path, default=Path("dist/source.zip"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    version = build_archive(root, args.tag, args.output.resolve())
    print(f"已生成 {args.output}，插件版本 {version}")


if __name__ == "__main__":
    main()
