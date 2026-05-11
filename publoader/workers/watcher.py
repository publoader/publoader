import importlib.util
import logging
import queue
import sys
import threading
import traceback

import pymongo

from publoader.http import http_client
from publoader.utils.utils import root_path
from publoader.webhook import PubloaderQueueWebhook
from publoader.workers import worker as watcher_worker

logger = logging.getLogger("publoader")

worker_paths = root_path.joinpath("publoader", "workers")
worker_paths.mkdir(parents=True, exist_ok=True)
bot_queue = queue.Queue()


def worker(
    worker_type: str,
    worker_module,
    http_client,
    queue_webhook,
    database_connection,
    **kwargs,
):
    """Run the worker."""
    while True:
        item = bot_queue.get()

        try:
            print(f"----{worker_type.title()}: Working on {item['_id']}----")
            logger.debug(f"----{worker_type.title()}: Working on {item['_id']}----")
            worker_module.run(item, http_client, queue_webhook, database_connection)
        except Exception as e:
            traceback.print_exc()
            logger.exception(f"{worker_type.title()} raised an error.")

        bot_queue.task_done()
        if bot_queue.qsize() == 0:
            # queue_webhook.send_queue_finished()

            if worker_type == "uploader":
                worker_module.check_all_chapters_uploaded()


def setup_thread(
    worker_type, queue_webhook, worker_module, database_connection, *args, **kwargs
):
    """Start the worker thread."""
    with bot_queue.mutex:
        bot_queue.queue.clear()

    chapters = worker_module.fetch_data_from_database(database_connection)
    for chapter in chapters:
        bot_queue.put(chapter)

    thread = threading.Thread(
        target=worker,
        daemon=True,
        args=(
            worker_type,
            worker_module,
            http_client,
            queue_webhook,
            database_connection,
        ),
        kwargs=kwargs,
    )
    thread.start()
    return thread


def open_worker_module(worker_type):
    """Load the runner file."""
    spec = importlib.util.spec_from_file_location(
        worker_type, worker_paths.joinpath(worker_type).with_suffix(".py")
    )
    foo = importlib.util.module_from_spec(spec)
    sys.modules[worker_type] = foo
    spec.loader.exec_module(foo)
    return foo


def main(
    worker_type: str,
    table_name: str,
    webhook_colour: str,
    restart_threads: bool,
    database_connection=None,
    **kwargs,
):
    """Start the watcher."""
    if database_connection is None:
        # Each subprocess gets its own MongoClient — sharing across fork is unsafe.
        from publoader.models.database import get_database_connection

        database_connection = get_database_connection()

    queue_webhook = PubloaderQueueWebhook(
        worker_type=worker_type, colour=webhook_colour
    )

    worker_module = open_worker_module(worker_type)

    # Turn-on the worker thread.
    thread = setup_thread(
        worker_type=worker_type,
        queue_webhook=queue_webhook,
        worker_module=worker_module,
        database_connection=database_connection,
    )
    print(f"Starting {worker_type.title()} watcher.")
    logger.info(f"Starting {worker_type.title()} watcher.")

    while True:
        if not thread.is_alive():
            if not restart_threads:
                watcher_worker.kill()
                break
            print(f"Restarting {worker_type.title()} Thread")
            thread = setup_thread(
                worker_type=worker_type,
                queue_webhook=queue_webhook,
                worker_module=worker_module,
                database_connection=database_connection,
            )

        try:
            with database_connection[table_name].watch(
                [{"$match": {"operationType": "insert"}}]
            ) as stream:
                for change in stream:
                    bot_queue.put(change["fullDocument"])
                    if not thread.is_alive():
                        break
        except pymongo.errors.PyMongoError as e:
            logger.error(f"{worker_type.title()} change-stream error: {e}")
            print(e)

    # Block until all tasks are done.
    bot_queue.join()
    print("All work completed")
