import multiprocessing

from publoader.workers import watcher


def main(database_connection=None, restart_threads=True):
    """Spawn the watcher subprocesses.

    `database_connection` is intentionally ignored for the children — pymongo's
    MongoClient is not fork-safe, so each watcher process opens its own.
    """
    try:
        watchers = [
            {"name": "uploader", "table": "to_upload", "colour": "26D454"},
            {"name": "deleter", "table": "to_delete", "colour": "C43542"},
            {"name": "editor", "table": "to_edit", "colour": "FFF71C"},
            {"name": "unavailable", "table": "to_unavailable", "colour": "9B9B9B"},
        ]
        for worker in watchers:
            process = multiprocessing.Process(
                target=watcher.main,
                kwargs={
                    "worker_type": worker["name"],
                    "table_name": worker["table"],
                    "webhook_colour": worker["colour"],
                    "restart_threads": restart_threads,
                },
                daemon=True,
            )
            process.start()
    except KeyboardInterrupt:
        kill()


def kill():
    """Kill the sub-processes."""
    print("Killing watcher processes.")

    for process in multiprocessing.active_children():
        process.terminate()
