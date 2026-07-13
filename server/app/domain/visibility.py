from __future__ import annotations

from collections.abc import Iterable

RANK = {"private": 0, "unlisted": 1, "public": 2}
FROM_RANK = ["private", "unlisted", "public"]


def effective_visibility(self: str, ancestors: Iterable[str] = ()) -> str:
    rank = RANK.get(self, 0)
    for a in ancestors:
        rank = min(rank, RANK.get(a, 0))
    return FROM_RANK[rank]


def is_public_nav_visible(self: str, ancestors: Iterable[str] = ()) -> bool:
    return effective_visibility(self, ancestors) == "public"
