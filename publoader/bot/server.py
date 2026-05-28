"""Discord control bot.

Runs as its own process. Connects to Discord and exposes prefix + slash
commands that forward into the main publoader instance via IPC. The bot is
control-only — run/error notifications keep going through the existing
discord_webhook path configured by `WEBHOOK_URL`.
"""
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import List, Optional

try:
    import discord
    from discord import app_commands
    from discord.ext import commands
except ImportError:  # pragma: no cover - import guard
    sys.stderr.write(
        "discord.py is required for the bot. Install with `pip install discord.py`.\n"
    )
    raise

from publoader.ipc import ipc_call, is_instance_running
from publoader.utils.config import config

logger = logging.getLogger("webhook")


# ---------- config helpers ----------

def _guild_id() -> Optional[int]:
    raw = config["Paths"].get("discord_guild_id") or os.environ.get(
        "PUBLOADER_DISCORD_GUILD"
    )
    try:
        return int(raw) if raw else None
    except (TypeError, ValueError):
        return None


def _bot_token() -> Optional[str]:
    return config["Credentials"].get("discord_bot_token") or os.environ.get(
        "PUBLOADER_DISCORD_TOKEN"
    )


def _allowed_channels() -> set:
    """Channel/thread IDs the bot will accept commands from. Empty set = anywhere."""
    raw = (
        config["Paths"].get("discord_allowed_channels")
        or os.environ.get("PUBLOADER_DISCORD_CHANNELS", "")
    )
    out: set = set()
    for tok in raw.replace(",", " ").split():
        tok = tok.strip()
        if tok.isdigit():
            out.add(int(tok))
    return out


def _channel_allowed(channel_id: Optional[int]) -> bool:
    allowed = _allowed_channels()
    if not allowed:
        return True
    return channel_id in allowed


def _admin_user_ids() -> set:
    raw = (
        config["Paths"].get("discord_admin_users")
        or os.environ.get("PUBLOADER_ADMIN_USERS", "")
    )
    return {int(t) for t in raw.replace(",", " ").split() if t.strip().isdigit()}


def _admin_role_ids() -> set:
    raw = (
        config["Paths"].get("discord_admin_roles")
        or os.environ.get("PUBLOADER_ADMIN_ROLES", "")
    )
    return {int(t) for t in raw.replace(",", " ").split() if t.strip().isdigit()}


def _is_admin(user) -> bool:
    """user can be a discord.User or discord.Member. Members carry roles."""
    users = _admin_user_ids()
    roles = _admin_role_ids()
    if not users and not roles:
        return True  # no restriction configured
    if user.id in users:
        return True
    member_role_ids = {r.id for r in getattr(user, "roles", []) or []}
    return bool(member_role_ids & roles)


def _extensions_dir() -> Path:
    return Path(
        os.environ.get("PUBLOADER_EXTENSIONS_DIR", "/app/publoader/extensions/src")
    )


def _list_extensions() -> List[str]:
    try:
        return sorted(
            p.name
            for p in _extensions_dir().iterdir()
            if p.is_dir() and not p.name.startswith((".", "__"))
        )
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return []


def _split_extensions(value: Optional[str]) -> Optional[list]:
    """For slash autocomplete fallback — accept comma/space-separated names."""
    if not value:
        return None
    parts = [p.strip() for p in value.replace(",", " ").split() if p.strip()]
    return parts or None


# ---------- bot ----------

class PubloaderBot(commands.Bot):
    def __init__(self):
        # Default (non-privileged) intents. To use prefix commands in channels,
        # enable Message Content Intent in the Developer Portal AND set
        # `intents.message_content = True` below.
        intents = discord.Intents.default()
        super().__init__(
            command_prefix=config["Paths"].get("discord_command_prefix") or "!",
            intents=intents,
        )

    async def setup_hook(self) -> None:
        # Channel gate for slash commands.
        async def _slash_check(interaction: discord.Interaction) -> bool:
            if _channel_allowed(interaction.channel_id):
                return True
            try:
                await interaction.response.send_message(
                    "This channel isn't allowed for publoader commands.",
                    ephemeral=True,
                )
            except discord.InteractionResponded:
                pass
            return False

        self.tree.interaction_check = _slash_check

        guild_id = _guild_id()
        try:
            if guild_id:
                guild = discord.Object(id=guild_id)
                self.tree.copy_global_to(guild=guild)
                synced = await self.tree.sync(guild=guild)
                logger.info(f"Synced {len(synced)} slash commands to guild {guild_id}")
            else:
                synced = await self.tree.sync()
                logger.info(f"Synced {len(synced)} global slash commands")
        except Exception:
            logger.exception("Failed to sync slash commands")

    async def on_ready(self) -> None:
        logger.info(f"Bot ready as {self.user} (id {self.user.id})")
        print(f"Bot ready as {self.user}")

    # ---------- IPC dispatch helpers ----------

    async def _dispatch(self, ctx: commands.Context, cmd: str, **payload) -> None:
        if not is_instance_running():
            await ctx.send("Publoader instance is not running.")
            return
        try:
            result = await asyncio.to_thread(ipc_call, cmd, **payload)
        except Exception as e:  # pragma: no cover - defensive
            await ctx.send(f"IPC call failed: `{e}`")
            return
        await ctx.send(f"`{cmd}` -> ```json\n{json.dumps(result, indent=2)[:1800]}\n```")

    async def _dispatch_slash(
        self, interaction: discord.Interaction, cmd: str, **payload
    ) -> None:
        # IPC is a blocking unix-socket call; defer so we don't hit the 3s
        # interaction response window.
        if not interaction.response.is_done():
            await interaction.response.defer(thinking=True)
        if not is_instance_running():
            await interaction.followup.send("Publoader instance is not running.")
            return
        try:
            result = await asyncio.to_thread(ipc_call, cmd, **payload)
        except Exception as e:  # pragma: no cover - defensive
            await interaction.followup.send(f"IPC call failed: `{e}`")
            return
        body = json.dumps(result, indent=2)[:1800]
        await interaction.followup.send(f"`{cmd}` -> ```json\n{body}\n```")

    async def build_status_embed(self) -> "discord.Embed":
        bot_latency_ms = round(self.latency * 1000) if self.latency else 0

        ipc_start = time.perf_counter()
        instance_up = is_instance_running()
        ipc_latency_ms = round((time.perf_counter() - ipc_start) * 1000)

        embed = discord.Embed(
            title="Publoader status",
            colour=discord.Colour.green() if instance_up else discord.Colour.orange(),
        )
        embed.add_field(
            name="Bot",
            value=f":green_circle: Online — `{bot_latency_ms}ms` heartbeat",
            inline=False,
        )
        embed.add_field(
            name="Scheduler (IPC)",
            value=(
                f":green_circle: Reachable — `{ipc_latency_ms}ms`"
                if instance_up
                else ":red_circle: Not running"
            ),
            inline=False,
        )

        extensions = _list_extensions()
        embed.add_field(
            name="Loaded extensions",
            value=(
                f"{len(extensions)}: " + ", ".join(extensions[:15])
                + ("…" if len(extensions) > 15 else "")
                if extensions
                else "none on disk"
            ),
            inline=False,
        )

        if instance_up:
            try:
                status = await asyncio.to_thread(ipc_call, "status")
                jobs = status.get("jobs", []) or []
                embed.add_field(name="PID", value=str(status.get("pid", "?")))
                embed.add_field(name="Scheduled jobs", value=str(len(jobs)))
                if jobs:
                    preview = "\n".join(f"• {j}" for j in jobs[:8])
                    if len(jobs) > 8:
                        preview += f"\n…and {len(jobs) - 8} more"
                    embed.add_field(
                        name="Upcoming",
                        value=f"```\n{preview[:1000]}\n```",
                        inline=False,
                    )
            except Exception as e:
                embed.add_field(name="Status fetch", value=f"failed: `{e}`", inline=False)

        return embed


# ---------- prefix-command picker UI ----------

class ExtensionPickerView(discord.ui.View):
    """Send a Select component bound to the invoking user. On submit, calls
    on_pick(interaction, picked_extensions_or_None). `__all__` resolves to None."""

    ALL_VALUE = "__all__"

    def __init__(self, on_pick, author_id: int, multi: bool = True, timeout: float = 120):
        super().__init__(timeout=timeout)
        self.on_pick = on_pick
        self.author_id = author_id

        extensions = _list_extensions()
        options = [
            discord.SelectOption(
                label="(all extensions)", value=self.ALL_VALUE, emoji="✨"
            )
        ]
        for name in extensions[:24]:  # 25-option cap minus the "all" option
            options.append(discord.SelectOption(label=name, value=name))

        self.select = discord.ui.Select(
            placeholder="Choose extension(s)…",
            options=options,
            min_values=1,
            max_values=min(len(options), 25) if multi else 1,
        )
        self.select.callback = self._on_select
        self.add_item(self.select)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.author_id:
            await interaction.response.send_message(
                "Only the user who invoked this command can pick.", ephemeral=True
            )
            return False
        return True

    async def _on_select(self, interaction: discord.Interaction):
        picked = list(self.select.values)
        if self.ALL_VALUE in picked:
            extensions = None  # "all" semantics
        else:
            extensions = picked
        for child in self.children:
            child.disabled = True
        try:
            await interaction.message.edit(view=self)
        except (discord.NotFound, discord.HTTPException):
            pass
        await self.on_pick(interaction, extensions)


async def _send_picker(bot: PubloaderBot, ctx: commands.Context, cmd: str, **base_payload):
    if not _list_extensions():
        await ctx.send("No extensions found on disk.")
        return

    async def on_pick(interaction: discord.Interaction, extensions: Optional[list]):
        payload = dict(base_payload)
        payload["extensions"] = extensions
        if not interaction.response.is_done():
            await interaction.response.defer(thinking=True)
        if not is_instance_running():
            await interaction.followup.send("Publoader instance is not running.")
            return
        try:
            result = await asyncio.to_thread(ipc_call, cmd, **payload)
        except Exception as e:
            await interaction.followup.send(f"IPC call failed: `{e}`")
            return
        body = json.dumps(result, indent=2)[:1800]
        await interaction.followup.send(f"`{cmd}` -> ```json\n{body}\n```")

    view = ExtensionPickerView(on_pick, ctx.author.id)
    await ctx.send(f"Pick extension(s) for `{cmd}`:", view=view)


# ---------- slash autocomplete ----------

async def _ext_autocomplete(
    interaction: discord.Interaction, current: str
) -> List[app_commands.Choice[str]]:
    extensions = _list_extensions()
    needle = (current or "").lower()
    return [
        app_commands.Choice(name=e, value=e)
        for e in extensions
        if not needle or needle in e.lower()
    ][:25]


# ---------- command registration ----------

def _register_commands(bot: PubloaderBot) -> None:
    # Channel gate for prefix commands.
    async def _prefix_check(ctx: commands.Context) -> bool:
        return _channel_allowed(ctx.channel.id)

    bot.add_check(_prefix_check)

    # ----- prefix commands -----
    # When called with no args, send an interactive dropdown. With explicit names,
    # dispatch directly (back-compat for typed usage).

    @bot.command(name="run")
    async def _run(ctx: commands.Context, *extensions):
        if extensions:
            await bot._dispatch(
                ctx, "run", extensions=[str(e) for e in extensions]
            )
        else:
            await _send_picker(bot, ctx, "run")

    @bot.command(name="force")
    async def _force(ctx: commands.Context, *extensions):
        if extensions:
            await bot._dispatch(
                ctx, "run", extensions=[str(e) for e in extensions], force=True
            )
        else:
            await _send_picker(bot, ctx, "run", force=True)

    @bot.command(name="clean")
    async def _clean(ctx: commands.Context, *extensions):
        if extensions:
            await bot._dispatch(
                ctx, "run", extensions=[str(e) for e in extensions], clean=True
            )
        else:
            await _send_picker(bot, ctx, "run", clean=True)

    @bot.command(name="reload")
    async def _reload(ctx: commands.Context):
        await bot._dispatch(ctx, "reload")

    @bot.command(name="restart")
    async def _restart(ctx: commands.Context):
        await bot._dispatch(ctx, "restart")

    @bot.command(name="status")
    async def _status(ctx: commands.Context):
        await bot._dispatch(ctx, "status")

    @bot.command(name="ping")
    async def _ping(ctx: commands.Context):
        embed = await bot.build_status_embed()
        await ctx.send(embed=embed)

    # ----- slash commands -----

    @bot.tree.command(name="ping", description="Bot heartbeat + scheduler status.")
    async def _slash_ping(interaction: discord.Interaction):
        await interaction.response.defer(thinking=True)
        embed = await bot.build_status_embed()
        await interaction.followup.send(embed=embed)

    @bot.tree.command(name="run", description="Run extensions on schedule.")
    @app_commands.describe(extension="Pick an extension (autocompletes from disk).")
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _slash_run(
        interaction: discord.Interaction, extension: Optional[str] = None
    ):
        await bot._dispatch_slash(
            interaction, "run", extensions=_split_extensions(extension)
        )

    @bot.tree.command(name="force", description="Force-run extensions regardless of schedule.")
    @app_commands.describe(extension="Pick an extension (autocompletes from disk).")
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _slash_force(
        interaction: discord.Interaction, extension: Optional[str] = None
    ):
        await bot._dispatch_slash(
            interaction,
            "run",
            extensions=_split_extensions(extension),
            force=True,
        )

    @bot.tree.command(name="clean", description="Clean run for extensions.")
    @app_commands.describe(extension="Pick an extension (autocompletes from disk).")
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _slash_clean(
        interaction: discord.Interaction, extension: Optional[str] = None
    ):
        await bot._dispatch_slash(
            interaction,
            "run",
            extensions=_split_extensions(extension),
            clean=True,
        )

    @bot.tree.command(name="reload", description="Reload extensions in-place.")
    async def _slash_reload(interaction: discord.Interaction):
        await bot._dispatch_slash(interaction, "reload")

    @bot.tree.command(name="restart", description="Restart the scheduler (pulls updates).")
    async def _slash_restart(interaction: discord.Interaction):
        await bot._dispatch_slash(interaction, "restart")

    @bot.tree.command(name="status", description="Show scheduler PID and pending jobs.")
    async def _slash_status(interaction: discord.Interaction):
        await bot._dispatch_slash(interaction, "status")

    # ----- /pull group -----
    _REPO_NAMES = ("base", "extensions", "extensions-private", "all")

    async def _repo_autocomplete(
        interaction: discord.Interaction, current: str
    ) -> List[app_commands.Choice[str]]:
        needle = (current or "").lower()
        return [
            app_commands.Choice(name=r, value=r)
            for r in _REPO_NAMES
            if not needle or needle in r.lower()
        ][:25]

    def _parse_repo_arg(value: Optional[str]) -> List[str]:
        """Accept 'all', a single repo, or comma/space-separated repo names."""
        if not value:
            return ["all"]
        parts = [p.strip() for p in value.replace(",", " ").split() if p.strip()]
        return parts or ["all"]

    @bot.tree.command(
        name="pull",
        description="git pull the base or extension repos (admin-only).",
    )
    @app_commands.describe(
        repo="Which repo(s) to update — `all`, `base`, `extensions`, `extensions-private`.",
    )
    @app_commands.autocomplete(repo=_repo_autocomplete)
    async def _slash_pull(
        interaction: discord.Interaction, repo: Optional[str] = None
    ):
        if not _is_admin(interaction.user):
            await interaction.response.send_message(
                "You are not allowed to pull repos.", ephemeral=True
            )
            return
        await bot._dispatch_slash(
            interaction, "pull", repos=_parse_repo_arg(repo)
        )

    @bot.command(name="pull")
    async def _prefix_pull(ctx: commands.Context, *repos: str):
        if not _is_admin(ctx.author):
            await ctx.send("You are not allowed to pull repos.")
            return
        repo_list = list(repos) if repos else ["all"]
        await bot._dispatch(ctx, "pull", repos=repo_list)

    # ----- /schedule group -----
    schedule_group = app_commands.Group(
        name="schedule",
        description="Inspect or modify scheduled extension runs (admin-only).",
    )

    @schedule_group.command(
        name="list", description="Show effective schedule + DB overrides."
    )
    async def _schedule_list(interaction: discord.Interaction):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await bot._dispatch_slash(interaction, "list_schedule")

    @schedule_group.command(
        name="set",
        description="Set or update an extension's daily schedule.",
    )
    @app_commands.describe(
        extension="Which extension to (re)schedule",
        hour="Hour 0-23 (UTC)",
        minute="Minute 0-59",
        day="Day of week 0-6 (Mon=0). Leave empty for every day.",
    )
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _schedule_set(
        interaction: discord.Interaction,
        extension: str,
        hour: app_commands.Range[int, 0, 23],
        minute: app_commands.Range[int, 0, 59],
        day: Optional[app_commands.Range[int, 0, 6]] = None,
    ):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await bot._dispatch_slash(
            interaction,
            "set_schedule",
            extension=extension,
            hour=hour,
            minute=minute,
            day=day,
        )

    @schedule_group.command(
        name="remove",
        description="Drop an extension's DB schedule override (falls back to schedule.json).",
    )
    @app_commands.describe(extension="Extension whose override to remove")
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _schedule_remove(interaction: discord.Interaction, extension: str):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await bot._dispatch_slash(
            interaction, "remove_schedule", extension=extension
        )

    bot.tree.add_command(schedule_group)

    # ----- prefix `schedule` ----
    @bot.group(name="schedule", invoke_without_command=True)
    async def _schedule_prefix(ctx: commands.Context):
        await bot._dispatch(ctx, "list_schedule")

    @_schedule_prefix.command(name="list")
    async def _schedule_prefix_list(ctx: commands.Context):
        await bot._dispatch(ctx, "list_schedule")

    @_schedule_prefix.command(name="set")
    async def _schedule_prefix_set(
        ctx: commands.Context,
        extension: str,
        hour: int,
        minute: int,
        day: Optional[int] = None,
    ):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        await bot._dispatch(
            ctx,
            "set_schedule",
            extension=extension,
            hour=hour,
            minute=minute,
            day=day,
        )

    @_schedule_prefix.command(name="remove")
    async def _schedule_prefix_remove(ctx: commands.Context, extension: str):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        await bot._dispatch(ctx, "remove_schedule", extension=extension)

    # ----- /removal group: chapter expiry behaviour -----
    _REMOVAL_MODES = ("unavailable", "delete")

    async def _removal_mode_autocomplete(
        interaction: discord.Interaction, current: str
    ) -> List[app_commands.Choice[str]]:
        needle = (current or "").lower()
        return [
            app_commands.Choice(name=m, value=m)
            for m in _REMOVAL_MODES
            if not needle or needle in m
        ]

    removal_group = app_commands.Group(
        name="removal",
        description="Control how expired chapters are dropped (unavailable vs delete).",
    )

    @removal_group.command(
        name="show",
        description="Show the current chapter-removal mode.",
    )
    async def _removal_show(interaction: discord.Interaction):
        await bot._dispatch_slash(interaction, "get_removal_mode")

    @removal_group.command(
        name="set",
        description="Set chapter-removal mode globally (admin-only). Extensions can still force a mode.",
    )
    @app_commands.describe(mode="`unavailable` keeps the chapter card; `delete` removes it outright.")
    @app_commands.autocomplete(mode=_removal_mode_autocomplete)
    async def _removal_set(interaction: discord.Interaction, mode: str):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await bot._dispatch_slash(interaction, "set_removal_mode", mode=mode)

    bot.tree.add_command(removal_group)

    @bot.group(name="removal", invoke_without_command=True)
    async def _removal_prefix(ctx: commands.Context):
        await bot._dispatch(ctx, "get_removal_mode")

    @_removal_prefix.command(name="show")
    async def _removal_prefix_show(ctx: commands.Context):
        await bot._dispatch(ctx, "get_removal_mode")

    @_removal_prefix.command(name="set")
    async def _removal_prefix_set(ctx: commands.Context, mode: str):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        await bot._dispatch(ctx, "set_removal_mode", mode=mode)

def run() -> int:
    token = _bot_token()
    if not token:
        logger.error("No discord bot token configured; bot will not start.")
        print("No discord bot token configured.")
        return 1

    bot = PubloaderBot()
    _register_commands(bot)
    try:
        bot.run(token)
    except discord.PrivilegedIntentsRequired:
        msg = (
            "Bot login rejected: a privileged intent is requested but disabled in "
            "the Developer Portal. Either enable the matching toggle under "
            "'Bot -> Privileged Gateway Intents' or remove the intent in "
            "PubloaderBot.__init__."
        )
        logger.error(msg)
        print(msg)
        return 1
    except discord.LoginFailure as e:
        logger.error(f"Bot login failed: {e}")
        print(f"Bot login failed: {e}")
        return 1
    except Exception:
        logger.exception("Discord bot crashed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(run())
