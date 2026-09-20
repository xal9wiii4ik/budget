"""``python -m budget_api.mcp`` — the ONE way this server is launched.

No console script on purpose: an entry point would only work inside the venv and
would be a second command to keep in step with the one in every client config.
"""

import asyncio

from budget_api.mcp.server import main

asyncio.run(main())
