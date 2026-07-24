"""Domain layer — pure business logic.

Layer contract (binding for all future tasks, see architecture §1):
imports NOTHING internal and NO framework — no FastAPI, no SQLAlchemy, no Pydantic
models from ``schemas``. Pure functions and value objects only. Everything above
(routers, services) may depend on this layer; this layer depends on nothing.
"""
