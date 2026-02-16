#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""Internal admin site entrypoint.

Implementation is under admin_site/.

- Runs on :5003 (or ADMIN_SITE_PORT)
- Access is restricted by CIDR (ADMIN_SITE_ALLOWED_CIDRS)
- Auth is a simple session login using env credentials
"""

from __future__ import annotations

import argparse
import os

from admin_site.app import create_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("ADMIN_SITE_BIND", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("ADMIN_SITE_PORT", "5003")))
    args = parser.parse_args()

    app = create_app()
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
