#!/usr/bin/env python3
"""Install the pinned official CPU runtime and Q8_0 model, verifying SHA-256."""
import hashlib
import pathlib
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
RUNTIME = ROOT / ".tools/llama-b10883"
MODEL_DIR = ROOT / ".tools/models/qwen3"
MODEL_NAME = "Qwen3-Embedding-0.6B-Q8_0.gguf"
MODEL_REVISION = "370f27d7550e0def9b39c1f16d3fbaa13aa67728"
MODEL_SHA = "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"
RUNTIME_SHA = "bb7df4783b12f164a1e829d4e692c216324ad919883f9e1c8abc77262db29145"


def verified(path, expected):
    if not path.is_file():
        return False
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest() == expected


def download(url, path, expected):
    path.parent.mkdir(parents=True, exist_ok=True)
    if verified(path, expected):
        print(f"Verified {path.name}", flush=True)
        return
    temporary = path.with_suffix(path.suffix + ".partial")
    with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as handle:
        while chunk := response.read(1024 * 1024):
            handle.write(chunk)
    if not verified(temporary, expected):
        raise RuntimeError(f"Checksum verification failed: {path.name}")
    temporary.replace(path)
    print(f"Downloaded and verified {path.name}", flush=True)


def main():
    archive = RUNTIME / "release.tar.gz"
    download("https://github.com/ggml-org/llama.cpp/releases/download/b10883/llama-b10883-bin-ubuntu-x64.tar.gz", archive, RUNTIME_SHA)
    with tarfile.open(archive) as package:
        package.extractall(RUNTIME, filter="data")
    download(f"https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/{MODEL_REVISION}/{MODEL_NAME}", MODEL_DIR / MODEL_NAME, MODEL_SHA)
    (MODEL_DIR / "model.sha256").write_text(f"{MODEL_SHA}  {MODEL_NAME}\n")
    print("Ready. Start with: bash scripts/embedding/start-qwen.sh")


if __name__ == "__main__":
    main()
