"""Services layer — external integrations and orchestration.

Layer contract (binding for all future tasks, see architecture §1):
may import ``domain``, ``models``, ``db``, ``config``. Must NOT import ``routers``
or ``app``. Houses external integrations (HTTP clients, third-party SDKs) and the
orchestration that composes ``domain`` logic with persistence.
"""
