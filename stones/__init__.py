"""Package stones — re-export публичного API stones.stones.

После переноса stones.py + rival_hook.js в папку stones/ пакет
должен оставаться прозрачным для main.py:

    from stones import StonesModule, handle, HELP

HOOK_PATH в stones/stones.py остаётся корректным — Path(__file__).parent
указывает на stones/, где рядом лежит rival_hook.js.
"""
from .stones import StonesModule, handle, HELP

__all__ = ["StonesModule", "handle", "HELP"]
