"""Build a Chrome Web Store ZIP containing only the declared runtime files."""
import json
import re
import subprocess
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]
if manifest["manifest_version"] != 3 or not re.fullmatch(r"(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}", version):
    raise SystemExit("Invalid Manifest V3 version")
if any(int(part) > 65535 for part in version.split(".")) or not any(int(part) for part in version.split(".")):
    raise SystemExit("Chrome version components must be 0..65535 and not all zero")
if len(sys.argv) > 1 and sys.argv[1] != "v" + version:
    raise SystemExit(f"Release tag must be v{version}")

paths = json.loads((root / "scripts/package-files.json").read_text(encoding="utf-8"))
if "manifest.json" not in paths or len(paths) != len(set(paths)):
    raise SystemExit("Package must contain manifest.json and no duplicate files")
for name in paths:
    path = root / name
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
        raise SystemExit(f"Invalid package path: {name}")
    if path.suffix == ".js":
        subprocess.run(["node", "--check", str(path)], check=True)
    if path.suffix == ".html":
        text = path.read_text(encoding="utf-8")
        for ref in re.findall(r'(?:src|href)=["\']([^"\']+)["\']', text):
            if ref.startswith(("#", "data:")):
                continue
            resource = (path.parent / ref).resolve()
            if not resource.is_relative_to(root) or resource.relative_to(root).as_posix() not in paths:
                raise SystemExit(f"Unpackaged HTML resource: {name}: {ref}")

referenced = [manifest["background"]["service_worker"], manifest["action"]["default_popup"]]
referenced.extend(manifest.get("icons", {}).values())
referenced.extend(manifest["action"].get("default_icon", {}).values())
if manifest.get("options_ui"):
    referenced.append(manifest["options_ui"]["page"])
for name in referenced:
    if name not in paths:
        raise SystemExit(f"Unpackaged manifest resource: {name}")

dist = root / "dist"
dist.mkdir(exist_ok=True)
output = dist / (root.name + "-" + version + ".zip")
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for name in sorted(paths):
        archive.write(root / name, name)
with ZipFile(output) as archive:
    if archive.testzip() is not None or set(archive.namelist()) != set(paths):
        raise SystemExit("ZIP verification failed")
print(f"Built {output.name}: {len(paths)} files")

