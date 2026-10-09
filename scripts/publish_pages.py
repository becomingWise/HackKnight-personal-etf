#!/usr/bin/env python3
"""Publish the committed version on origin/main to the existing gh-pages branch."""

import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
LIVE_URL = "https://becomingwise.github.io/HackKnight-personal-etf/"
SITE_FILES = (
    "index.html",
    "css/styles.css",
    "data/assets.json",
    "data/chat-demo.json",
    "js/app.js",
    "js/controller.js",
    "js/services.js",
    "js/ui.js",
    "js/portfolio.js",
    ".nojekyll",
)


def git(*args, cwd=ROOT, capture=False):
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True,
        stdout=subprocess.PIPE if capture else None,
    )


def main():
    git("fetch", "origin")
    source_commit = git("rev-parse", "origin/main", capture=True).stdout.decode().strip()
    remote_url = git("remote", "get-url", "origin", capture=True).stdout.decode().strip()
    git("rev-parse", "--verify", "origin/gh-pages", capture=True)

    # A temporary checkout keeps publishing independent of your working branch.
    # Start from the existing deployment so its history and other files survive.
    with tempfile.TemporaryDirectory(prefix="myetf-publish-") as temporary:
        deployment = Path(temporary)
        git("init", "--quiet", cwd=deployment)
        git("fetch", "--quiet", str(ROOT), "refs/remotes/origin/gh-pages", cwd=deployment)
        git("checkout", "--quiet", "-b", "gh-pages", "FETCH_HEAD", cwd=deployment)
        git("remote", "add", "origin", remote_url, cwd=deployment)
        for relative in SITE_FILES:
            target = deployment / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git("show", f"{source_commit}:{relative}", capture=True).stdout)
        (deployment / "version.json").write_text(
            json.dumps({"app": "MyETF", "sourceCommit": source_commit}, indent=2) + "\n"
        )
        git("add", "--", *SITE_FILES, "version.json", cwd=deployment)
        changed = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=deployment)
        if changed.returncode == 0:
            print("This version is already on gh-pages.")
        elif changed.returncode == 1:
            # Match the identity used by the source checkout, including local overrides.
            for setting in ("user.name", "user.email"):
                value = git("config", "--get", setting, capture=True).stdout.decode().strip()
                git("config", setting, value, cwd=deployment)
            git("commit", "-m", f"Publish MyETF from main ({source_commit[:7]})", cwd=deployment)
            # Never force-push: another teammate's concurrent update will block this push.
            git("push", "origin", "gh-pages", cwd=deployment)
        else:
            raise RuntimeError("Could not inspect the deployment changes.")

    git("fetch", "origin", "gh-pages")
    print(f"Published source commit: {source_commit}")
    print(f"GitHub Pages will build the website at {LIVE_URL}")


if __name__ == "__main__":
    main()
