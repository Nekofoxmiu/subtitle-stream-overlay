# Embedded QuickJS Runtime

Place `qjs.exe` (QuickJS or QuickJS-NG) in this directory to embed it into packaged builds.

- Expected file: `vendor/quickjs/qjs.exe`
- Forge will copy it to: `resources/bin/qjs.exe`
- Runtime flag used by app: `--js-runtimes quickjs:<path-to-qjs.exe>`

If `qjs.exe` is not present, the app will fall back to downloading QuickJS automatically at runtime.
