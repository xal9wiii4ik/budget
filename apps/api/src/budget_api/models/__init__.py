"""ORM models package.

Re-exports every model so that ``alembic/env.py`` (which imports this package)
sees them all registered on ``Base.metadata``.
"""

from budget_api.models.account import Account
from budget_api.models.bank_category_map import BankCategoryMap
from budget_api.models.base import Base
from budget_api.models.category import Category
from budget_api.models.category_limit import CategoryLimit
from budget_api.models.deposit import Deposit
from budget_api.models.exchange_rate import ExchangeRate
from budget_api.models.goal import Goal, GoalContribution
from budget_api.models.goal_item import GoalItem, GoalItemFile
from budget_api.models.merchant_category_map import MerchantCategoryMap
from budget_api.models.pat_audit_log import PatAuditLog
from budget_api.models.personal_access_token import PersonalAccessToken
from budget_api.models.profile import Profile
from budget_api.models.receipt import Receipt
from budget_api.models.recurring_template import RecurringTemplate
from budget_api.models.refresh_token import RefreshToken
from budget_api.models.statement_import import (
    StatementImport,
    StatementImportRow,
)
from budget_api.models.transaction import Transaction
from budget_api.models.user import User

__all__ = [
    "Account",
    "BankCategoryMap",
    "Base",
    "Category",
    "CategoryLimit",
    "Deposit",
    "ExchangeRate",
    "Goal",
    "GoalContribution",
    "GoalItem",
    "GoalItemFile",
    "MerchantCategoryMap",
    "PatAuditLog",
    "PersonalAccessToken",
    "Profile",
    "Receipt",
    "RecurringTemplate",
    "RefreshToken",
    "StatementImport",
    "StatementImportRow",
    "Transaction",
    "User",
]
