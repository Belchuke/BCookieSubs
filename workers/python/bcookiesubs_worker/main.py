
from __future__ import annotations

import logging
import signal
import sys

from .config import ConfigError, WorkerConfig
from .grpc_client import WorkerClient
from .jobs import JobRunner


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger = logging.getLogger("bcookiesubs.worker")

    try:
        config = WorkerConfig.from_env()
    except ConfigError as exc:
        logger.error("configuration error: %s", exc)
        return 2

    logger.info(
        "starting worker %s -> %s (capabilities=%s, max_concurrency=%d)",
        config.worker_name,
        config.server_url,
        ",".join(config.capabilities),
        config.max_concurrency,
    )

    runner = JobRunner(max_concurrency=config.max_concurrency)
    client = WorkerClient(config, runner=runner)
    runner.bind(client._send_job_progress, client._send_job_result)

    def _handle_signal(signum, _frame):
        logger.info("signal %s received; disconnecting", signal.Signals(signum).name)
        client.stop()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    try:
        client.run_forever()
    except KeyboardInterrupt:
        client.stop()
        return 0
    finally:
        logger.info("worker stopped")

    fatal = client.fatal_error
    if fatal is not None:
        if config.enrollment_token:
            logger.error(
                "enrollment failed (%s). Mint a new enrollment code in the Workers page, "
                "put it in WORKER_ENROLLMENT_TOKEN / LOCAL_WORKER_ENROLLMENT_TOKEN, then "
                "recreate this container (docker compose up -d --force-recreate python-worker).",
                fatal,
            )
        else:
            logger.error(
                "authentication failed (%s). The stored credentials are no longer valid; "
                "remove this worker's data volume and re-enroll with a fresh code.",
                fatal,
            )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())