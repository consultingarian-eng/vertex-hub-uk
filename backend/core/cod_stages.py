"""COD stage DISPLAY order — the backend half of the single source of truth.

The Cycle of Development runs:
    Stage 1 Foundation -> Stage 2 Self Management -> Stage 3 Leader ->
    Stage SL Sector/Site Leader -> Stage 4 Team Builder
    -> Stage 5 Assistant Owner  (NOT BUILT)

The real Stage 5 is Assistant Owner and it comes after Stage 4, but its COD
content is not written yet. The number 5 is already taken by Sector/Site
Leader, which cannot be renumbered (see below), so Assistant Owner needs a
different stored number when it is built -- 6 -- appended to COD_STAGE_ORDER
after the 4. Do NOT give it stage 5.

Stage SL is STORED as stage 5, and it must stay 5: ``(stage, topic)`` is the
identity key for every training module, module_progress row, COD sheet rung
and check-queue card in production, so renumbering it would orphan all of
them. Only the order endpoints EMIT stages in changes — SL sits between
Stage 3 and Stage 4.

Mirror of frontend/src/components/cod/stageOrder.ts. Use this wherever an
endpoint hands the UI a stage sequence it renders directly; never to build a
query filter or to write a stage value.
"""

from typing import Iterable, List

#: Stored stage numbers, in the order a person actually meets them.
COD_STAGE_ORDER: List[int] = [1, 2, 3, 5, 4]


def cod_stage_rank(stage) -> int:
    """Where a stored stage number sits in the display order.

    Stages the COD doesn't know about sort after the known ones, in numeric
    order, so an unexpected value never jumps to the front of a list.
    """
    try:
        s = int(stage)
    except (TypeError, ValueError):
        return len(COD_STAGE_ORDER) + 10_000
    try:
        return COD_STAGE_ORDER.index(s)
    except ValueError:
        return len(COD_STAGE_ORDER) + s


def sort_cod_stages(stages: Iterable) -> List[int]:
    """A new list of stage numbers in COD display order."""
    return sorted((int(s) for s in stages), key=cod_stage_rank)
