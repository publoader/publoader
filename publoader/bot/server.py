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
from typing import Optional

try:
    import discord
    from discord import app_commands
    from discord.ext import commands
except ImportError as exc:  # pragma: no cover - import guard
    sys.stderr.write(
        "discord.py is required for the bot. Install with `pip install discord.py`.\n"
    )
    raise

from publoader.ipc import ipc_call, is_instance_running
from publoader.utils.config import config

logger = logging.getLogger("webhook")


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


def _split_extensions(value: Optional[str]) -> Optional[list]:
    """Slash commands can't take varargs — accept a comma/space-separated string."""
    if not value:
        return None
    parts = [p.strip() for p in value.replace(",", " ").split() if p.strip()]
    return parts or None


class PubloaderBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(
            command_prefix=config["Paths"].get("discord_command_prefix") or "!",
            intents=intents,
        )

    async def setup_hook(self) -> None:
        # Sync slash commands. Guild-scoped sync is near-instant; global sync
        # propagates within an hour, which is fine for a long-running bot.
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

    # ---------- Discord commands ----------

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
        # interaction response window if the scheduler is busy.
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
        """Shared payload for the !ping / /ping commands."""
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


def _register_commands(bot: PubloaderBot) -> None:
    # ----- prefix commands (back-compat) -----
    @bot.command(name="run")
    async def _run(ctx: commands.Context, *extensions):
        await bot._dispatch(
            ctx, "run", extensions=[str(e) for e in extensions] if extensions else None
        )

    @bot.command(name="force")
    async def _force(ctx: commands.Context, *extensions):
        await bot._dispatch(
            ctx,
            "run",
            extensions=[str(e) for e in extensions] if extensions else None,
            force=True,
        )

    @bot.command(name="clean")
    async def _clean(ctx: commands.Context, *extensions):
        await bot._dispatch(
            ctx,
            "run",
            extensions=[str(e) for e in extensions] if extensions else None,
            clean=True,
        )

    @bot.command(name="reload")
    async def _reload(ctx: commands.Context):
        await bot._dispatch(ctx, "reload")

    @bot.command(name="restart")
    async def _restart(ctx: commands.Context):
        await bot._dispatch(ctx, "restart")

    @bot.command(name="status")
    async def _status(ctx: commands.Context):
        await bot._dispatch(ctx, "status")

    @bot.command(name="add")
    async def _add_series(ctx: commands.Context, manga_id: str, *, title: str = ""):
        await bot._dispatch(
            ctx, "add_series", data={"id": manga_id, "title": title or manga_id}
        )

    # ----- slash commands -----
    extension_arg = app_commands.describe(
        extension="Extension name(s). Comma- or space-separated for multiple. Omit to target all."
    )

    @bot.command(name="ping")
    async def _ping(ctx: commands.Context):
        embed = await bot.build_status_embed()
        await ctx.send(embed=embed)

    @bot.tree.command(name="ping", description="Bot heartbeat + scheduler status.")
    async def _slash_ping(interaction: discord.Interaction):
        await interaction.response.defer(thinking=True)
        embed = await bot.build_status_embed()
        await interaction.followup.send(embed=embed)

    @bot.tree.command(name="run", description="Run extensions on schedule.")
    @extension_arg
    async def _slash_run(
        interaction: discord.Interaction, extension: Optional[str] = None
    ):
        await bot._dispatch_slash(
            interaction, "run", extensions=_split_extensions(extension)
        )

    @bot.tree.command(name="force", description="Force-run extensions regardless of schedule.")
    @extension_arg
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
    @extension_arg
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

    @bot.tree.command(name="add", description="Persist a series record into manga_data.json.")
    @app_commands.describe(
        manga_id="MangaDex manga UUID",
        title="Display title (defaults to the id)",
    )
    async def _slash_add(
        interaction: discord.Interaction,
        manga_id: str,
        title: Optional[str] = None,
    ):
        await bot._dispatch_slash(
            interaction,
            "add_series",
            data={"id": manga_id, "title": title or manga_id},
        )


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
    except Exception:
        logger.exception("Discord bot crashed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(run())
