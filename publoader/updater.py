import json
import logging
import shutil
import tarfile
import time
from pathlib import Path
from typing import Tuple

import github
import requests
from github import Github
from github.Commit import Commit

from publoader.utils.config import config, resources_path
from publoader.utils.utils import atomic_write_text, root_path
from publoader.webhook import PubloaderWebhook

logger = logging.getLogger("publoader")


class PubloaderUpdater:
    def __init__(self):
        self.root_path = root_path
        self.update_path = self.root_path.joinpath("temp")
        self.update_path.mkdir(parents=True, exist_ok=True)

        self.commits_file = resources_path.joinpath(config["Paths"]["commits_path"])
        github_token = config["Repo"].get("github_access_token") or None
        self.github = Github(github_token) if github_token else Github()
        self.local_commits = self._open_commits()
        self.latest_commit_sha = self.local_commits.get("base_repo")
        self.latest_extension_sha = self.local_commits.get("extension_repo")
        self.latest_extension_private_sha = self.local_commits.get(
            "extension_private_repo"
        )

        self.repo_owner = config["Repo"]["repo_owner"]
        self.base_repo = config["Repo"]["base_repo_path"]
        self.extensions_repo = config["Repo"]["extensions_repo_path"]
        self.extensions_private_repo = config["Repo"].get(
            "extensions_private_repo_path"
        )
        self.extensions_path = "publoader/extensions"

    def _open_commits(self):
        """Open the commits file."""
        try:
            with open(self.commits_file, "r") as login_file:
                token = json.load(login_file)
            return token
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save_commits(self, data=None):
        """Save the commits file."""
        if data is None:
            data = {
                "base_repo": self.latest_commit_sha,
                "extension_repo": self.latest_extension_sha,
                "extension_private_repo": self.latest_extension_private_sha,
            }

        atomic_write_text(self.commits_file, json.dumps(data, indent=4))

    def _get_latest_commit(self, repo):
        commits = repo.get_commits()
        latest_commit: Commit = commits[0]
        return latest_commit

    def _extract_tarball(self, archive_url: str, download_path: Path) -> bool:
        """Stream a tarball and extract its contents (without the wrapper dir)
        into download_path. Returns True on failure."""
        download_path.mkdir(parents=True, exist_ok=True)

        headers = {}
        token = config["Repo"].get("github_access_token")
        if token:
            headers["Authorization"] = f"token {token}"

        try:
            response = requests.get(
                archive_url, headers=headers, stream=True, timeout=120
            )
            response.raise_for_status()
        except requests.RequestException as e:
            logger.error(f"Failed to download tarball {archive_url}: {e}")
            return True

        target_root = download_path.resolve()
        try:
            with tarfile.open(fileobj=response.raw, mode="r|gz") as tar:
                for member in tar:
                    # Skip wrapper "owner-repo-sha/" directory
                    parts = member.name.split("/", 1)
                    if len(parts) < 2 or not parts[1]:
                        continue
                    member.name = parts[1]

                    # Defend against path traversal in archive entries
                    candidate = (download_path / member.name).resolve()
                    try:
                        candidate.relative_to(target_root)
                    except ValueError:
                        logger.warning(
                            f"Skipping unsafe tarball entry: {member.name}"
                        )
                        continue

                    # Drop symlinks/hardlinks that could escape the target dir
                    if member.issym() or member.islnk():
                        logger.warning(
                            f"Skipping link entry in tarball: {member.name}"
                        )
                        continue

                    tar.extract(member, download_path)
        except (tarfile.TarError, OSError) as e:
            logger.error(f"Failed to extract tarball: {e}")
            return True

        return False

    def fetch_repo(
        self, repo_name, commit_sha_var, download_path
    ) -> Tuple[bool, bool, str]:
        try:
            repo = self.github.get_repo(f"{self.repo_owner}/{repo_name}")
        except github.UnknownObjectException:
            logger.exception(f"Error fetching repo {repo_name}")
            return False, False, commit_sha_var

        logger.info(f"Checking for update in: {repo}")

        latest_remote_commit = self._get_latest_commit(repo)
        if commit_sha_var is not None and commit_sha_var == latest_remote_commit.sha:
            logger.info(
                f"No new commit, not updating. Latest commit: {latest_remote_commit.sha}"
            )
            return False, False, commit_sha_var

        logger.info(f"Update found, downloading {latest_remote_commit.sha}")
        PubloaderWebhook(
            extension_name=None,
            title=f"Update found for repo {repo_name}",
            description=f"SHA: `{latest_remote_commit.sha}`",
        ).main()

        try:
            archive_url = repo.get_archive_link("tarball", latest_remote_commit.sha)
        except github.GithubException as e:
            logger.exception(f"Couldn't get archive link for {repo_name}: {e}")
            return False, True, commit_sha_var

        failed_download = self._extract_tarball(archive_url, download_path)
        return True, failed_download, latest_remote_commit.sha

    def move_files(self):
        shutil.copytree(
            self.update_path,
            self.root_path,
            copy_function=shutil.move,
            dirs_exist_ok=True,
        )
        shutil.rmtree(self.update_path, ignore_errors=True)

    def update(self):
        print(f"Looking for new updates.")
        extensions_path = self.update_path.joinpath(self.extensions_path)

        base_repo_success, base_repo_failed, self.latest_commit_sha = self.fetch_repo(
            self.base_repo, self.latest_commit_sha, self.update_path
        )

        time.sleep(8)
        extensions_private_repo_success = False
        extensions_private_repo_failed = False

        if self.extensions_private_repo is not None:
            (
                extensions_private_repo_success,
                extensions_private_repo_failed,
                self.latest_extension_private_sha,
            ) = self.fetch_repo(
                self.extensions_private_repo,
                self.latest_extension_private_sha,
                extensions_path,
            )

            time.sleep(8)

        (
            extensions_repo_success,
            extensions_repo_failed,
            self.latest_extension_sha,
        ) = self.fetch_repo(
            self.extensions_repo, self.latest_extension_sha, extensions_path
        )

        if base_repo_failed or extensions_private_repo_failed or extensions_repo_failed:
            logger.warning(f"Downloading new repo update failed, not updating.")
            PubloaderWebhook(
                extension_name=None,
                title=f"Updating repos failed, not downloading.",
            ).send()
            shutil.rmtree(self.update_path, ignore_errors=True)
            return

        if (
            base_repo_success
            or extensions_private_repo_success
            or extensions_repo_success
        ):
            PubloaderWebhook(
                extension_name=None,
                title=f"Update download complete, applying changes.",
            ).send()
            Path(config["Paths"]["mdauth_path"]).unlink(missing_ok=True)
            logger.info("Update download complete, applying changes.")
            self.move_files()
            self._save_commits()
            print(f"Finished looking for new updates.")


if __name__ == "__main__":
    PubloaderUpdater().update()
