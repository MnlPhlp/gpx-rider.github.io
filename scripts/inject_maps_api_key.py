#!/usr/bin/env python3
# Run only by .github/workflows/deploy-pages.yml, after checkout and before
# the Pages artifact is uploaded. Bakes the deploy-time values into
# app/config.mjs so the live demo works without visitors pasting their own:
#   MAPS_API_KEY     — the Google Maps key (expected to be an HTTP referrer-
#                      restricted key scoped to the Pages origin); config.mjs
#                      is shared by the app and the landing page, so both
#                      light up.
#   MAPILLARY_TOKEN  — a Mapillary client token for the opt-in street
#                      imagery (public by design, like a browser Maps key).
# It also injects the optional HEAD repository variable immediately after
# <head> in app/index.html — the public landing page, the site's entry point —
# which is intended for deployment-only tags such as analytics snippets. If a
# value is unset this leaves the matching source default unchanged, so local
# checkouts and forks are unaffected.
#
# The values are base64-encoded in the file, not encrypted — see config.mjs
# for why (it's cosmetic, not a security boundary). scripts/dev_server.py
# performs the same substitution on the fly for local development.
import base64
import os
import pathlib
import re

CONFIG_PATH = pathlib.Path("app/config.mjs")
INDEX_PATH = pathlib.Path("app/index.html")
# (constant in config.mjs, environment variable holding its value)
DEPLOY_VALUES = (
    ("DEPLOYED_MAPS_API_KEY_B64", "MAPS_API_KEY"),
    ("DEPLOYED_MAPILLARY_TOKEN_B64", "MAPILLARY_TOKEN"),
)
HEAD_PATTERN = re.compile(r"(?m)^([ \t]*<head>[ \t]*)$")


def inject_deploy_values():
    text = CONFIG_PATH.read_text()
    for const_name, env_var in DEPLOY_VALUES:
        value = os.environ.get(env_var, "").strip()
        encoded = base64.b64encode(value.encode()).decode() if value else ""
        pattern = re.compile(rf'const {const_name} = ".*";')
        text, count = pattern.subn(f'const {const_name} = "{encoded}";', text)
        if count != 1:
            raise SystemExit(f"expected exactly one {const_name} line in {CONFIG_PATH}, found {count}")
    CONFIG_PATH.write_text(text)


def inject_head_html():
    head_html = os.environ.get("HEAD", "").strip()
    if not head_html:
        return

    text = INDEX_PATH.read_text()
    indented_head = "\n".join(f"    {line}" if line else "" for line in head_html.splitlines())
    updated, count = HEAD_PATTERN.subn(lambda match: f"{match.group(1)}\n{indented_head}", text, count=1)
    if count != 1:
        raise SystemExit(f"expected exactly one <head> line in {INDEX_PATH}, found {count}")
    INDEX_PATH.write_text(updated)


def main():
    inject_deploy_values()
    inject_head_html()


if __name__ == "__main__":
    main()
