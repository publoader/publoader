import configparser
import logging
from calendar import WEDNESDAY
from datetime import time

from publoader.utils.utils import root_path

logger = logging.getLogger("publoader")


def load_config_info(config: configparser.RawConfigParser):
    if config["Paths"].get("mangadex_api_url", "") == "":
        logger.warning("Mangadex api path empty, using default.")
        config["Paths"]["mangadex_api_url"] = "https://api.mangadex.org"

    if config["Paths"].get("mangadex_auth_url", "") == "":
        logger.warning("Mangadex auth path empty, using default.")
        config["Paths"][
            "mangadex_auth_url"
        ] = "https://auth.mangadex.org/realms/mangadex/protocol/openid-connect"

    if config["Paths"].get("mdauth_path", "") == "":
        logger.info("Mdauth path empty, using default.")
        config["Paths"]["mdauth_path"] = ".mdauth"

    if config["Paths"].get("commits_path", "") == "":
        logger.info("Commits path empty, using default.")
        config["Paths"]["commits_path"] = ".commits"

    if config["Paths"].get("resources_path", "") == "":
        logger.info("Resources path empty, using default.")
        config["Paths"]["resources_path"] = "resources"

    if config["Paths"].get("manga_data_path", "") == "":
        logger.info("Manga data path empty, using default.")
        config["Paths"]["manga_data_path"] = "manga_data.json"

    if config["Repo"].get("repo_owner", "") == "":
        config["Repo"]["repo_owner"] = "ArdaxHz"

    if config["Repo"].get("base_repo_path", "") == "":
        config["Repo"]["base_repo_path"] = "publoader"

    if config["Repo"].get("extensions_repo_path", "") == "":
        config["Repo"]["extensions_repo_path"] = "publoader-extensions"


def open_config_file() -> configparser.RawConfigParser:
    # Open config file and read values
    if config_file_path.exists():
        config = configparser.RawConfigParser()
        config.read(config_file_path)
        logger.info("Loaded config file.")
    else:
        logger.critical("Config file not found, exiting.")
        raise FileNotFoundError("Config file not found.")

    load_config_info(config)
    return config


config_file_path = root_path.joinpath("config").with_suffix(".ini")
config = open_config_file()
resources_path = root_path.joinpath(config["Paths"]["resources_path"])
resources_path.mkdir(parents=True, exist_ok=True)

mangadex_api_url = config["Paths"]["mangadex_api_url"]
mangadex_auth_url = config["Paths"]["mangadex_auth_url"]
md_upload_api_url = f"{mangadex_api_url}/upload"


try:
    ratelimit_time = int(config["Options"].get("mangadex_ratelimit_time", ""))
except (ValueError, KeyError):
    ratelimit_time = 2


try:
    upload_retry = int(config["Options"].get("upload_retry", ""))
except (ValueError, KeyError):
    upload_retry = 3

try:
    max_requests = int(config["Options"].get("max_requests", ""))
except (ValueError, KeyError):
    max_requests = 5


try:
    max_log_days = int(config["Options"].get("max_log_days", ""))
except (ValueError, KeyError):
    max_log_days = 30


try:
    daily_run_time_daily_hour = int(
        config["Options"].get("bot_run_time_daily", "").split(":")[0]
    )
except (ValueError, KeyError):
    daily_run_time_daily_hour = 15

try:
    daily_run_time_daily_minute = int(
        config["Options"].get("bot_run_time_daily", "").split(":")[1]
    )
except (ValueError, KeyError):
    daily_run_time_daily_minute = 0

try:
    daily_run_time_checks_hour = int(
        config["Options"].get("bot_run_time_checks", "").split(":")[0]
    )
except (ValueError, KeyError):
    daily_run_time_checks_hour = 1

try:
    daily_run_time_checks_minute = int(
        config["Options"].get("bot_run_time_checks", "").split(":")[1]
    )
except (ValueError, KeyError):
    daily_run_time_checks_minute = 0

DEFAULT_TIME = time(hour=daily_run_time_daily_hour, minute=daily_run_time_daily_minute)
CLEAN_TIME = time(hour=daily_run_time_checks_hour, minute=daily_run_time_checks_minute)
DEFAULT_CLEAN_DAY = WEDNESDAY
ALL_DAYS = range(7)
