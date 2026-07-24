"""Users routes — full stock users router (GET/PATCH /me, superuser-gated /{id}).

Mounted at prefix ``/users`` in ``app.py``. The /{id} routes carry
``Depends(get_current_superuser)`` (plan §13.2); with no superuser in 1.1 they are
dead-but-harmless.
"""

from budget_api.auth import fastapi_users
from budget_api.schemas.user import UserRead, UserUpdate

router = fastapi_users.get_users_router(UserRead, UserUpdate)  # type: ignore[arg-type]
