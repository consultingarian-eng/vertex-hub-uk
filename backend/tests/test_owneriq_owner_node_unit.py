"""owneriq_write.pick_owner_node — the office owner is the root with the most
direct reports, not the first root by name (a name-sorted roster puts MC
admins and applicants ahead of the owner, and reconcile would then reparent
the real owner under an admin)."""
from owneriq_write import pick_owner_node


def test_owner_is_root_with_most_reports():
    roots = ["1000110", "1001540", "1021383"]          # admin, owner, agency admin
    parents = ["1001540"] * 5 + ["1000110"] + [None, 0]
    assert pick_owner_node(roots, parents, set()) == "1001540"


def test_global_roots_are_skipped():
    roots = ["9", "1001540"]
    parents = ["9"] * 10 + ["1001540"] * 3
    assert pick_owner_node(roots, parents, {"9"}) == "1001540"


def test_all_childless_falls_back_to_roster_order():
    assert pick_owner_node(["a", "b"], [None, None], set()) == "a"


def test_only_global_roots_still_returns_one():
    assert pick_owner_node(["9"], [], {"9"}) == "9"


def test_no_roots():
    assert pick_owner_node([], [], set()) is None
