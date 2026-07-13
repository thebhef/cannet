"""PyInstaller entry shim. ``__main__`` uses relative imports, so the freeze needs a concrete module-level entrypoint that calls into the package."""

from __future__ import annotations

from cannet_python_can.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
