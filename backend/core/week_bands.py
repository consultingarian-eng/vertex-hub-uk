"""The owner's "What Good Looks Like" weekly bands — sign-ups in one Bells week.

    Super Green   10+          beating the standard
    Green         8–9          meeting the standard
    Amber         6–7          developing performance
    Red           5 and under  below the required standard

A "Green Week" is Green or better (8+). Every weekly green count in the app —
the Bells green %, the Green Week badge, the Sales Development Path ramp —
reads these constants, so the standard lives in one place.
"""

SUPER_GREEN_WEEK_SALES = 10
GREEN_WEEK_SALES = 8
AMBER_WEEK_SALES = 6
# Anything below AMBER_WEEK_SALES (5 and under) is Red. The owner's playbook:
# "Must achieve 7 sign ups in a week to come out of red zone".
RED_EXIT_WEEK_SALES = 7

WEEK_BANDS = (
    (SUPER_GREEN_WEEK_SALES, "super_green", "Super Green"),
    (GREEN_WEEK_SALES, "green", "Green"),
    (AMBER_WEEK_SALES, "amber", "Amber"),
    (0, "red", "Red"),
)


def week_band(sign_ups: int | float | None) -> str:
    """'super_green' | 'green' | 'amber' | 'red' for a week's sign-ups."""
    n = sign_ups or 0
    for floor, key, _label in WEEK_BANDS:
        if n >= floor:
            return key
    return "red"


def is_green_week(sign_ups: int | float | None) -> bool:
    """Green or better — the owner's 'meeting the standard' (8+)."""
    return (sign_ups or 0) >= GREEN_WEEK_SALES
