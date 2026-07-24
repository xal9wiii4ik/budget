"""ORM models package.

Re-exports every model so that ``alembic/env.py`` (which imports this package)
sees them all registered on ``Base.metadata``. Models register here from task 1.2.
"""

from budget_api.models.base import Base

__all__ = ["Base"]
