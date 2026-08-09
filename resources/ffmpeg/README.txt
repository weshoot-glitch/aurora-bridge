Place the platform ffmpeg binary here before packaging.

  Windows:  resources/ffmpeg/ffmpeg.exe

electron-builder copies this folder to <resources>/ffmpeg via the build
"extraResources" config, and the Camera Relay resolves it at runtime via
process.resourcesPath (bundled). If absent, the relay falls back to a
PATH-resolved ffmpeg (dev), then an explicit setting; if none is found the
Camera state reports the honest detail "ffmpeg not available" — never a fake
LIVE.

The binary is intentionally NOT committed to the repo.
