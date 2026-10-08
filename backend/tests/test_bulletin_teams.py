"""Targeted checks for the derived countrywide team bulletin."""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

from bson import ObjectId


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from routes import bulletin  # noqa: E402


class _Cursor:
    def __init__(self, rows):
        self.rows = list(rows)
        self.index = 0

    async def to_list(self, _limit):
        return list(self.rows)

    def __aiter__(self):
        self.index = 0
        return self

    async def __anext__(self):
        if self.index >= len(self.rows):
            raise StopAsyncIteration
        row = self.rows[self.index]
        self.index += 1
        return row


class _StaticCollection:
    def __init__(self, rows):
        self.rows = rows

    def find(self, _query, _projection):
        return _Cursor(self.rows)


class _UsersCollection:
    def __init__(self, leaders, active_user_ids):
        self.leaders = leaders
        self.active_users = [{"_id": user_id} for user_id in active_user_ids]
        self.by_id = {str(row["_id"]): row for row in leaders}

    def find(self, query, _projection):
        # The builder asks for leaders AND admins (an admin who runs their own
        # crew is a real team); the second call is the active-user snapshot.
        if "role" in query:
            return _Cursor(self.leaders)
        return _Cursor(self.active_users)

    async def find_one(self, query, _projection=None):
        # core/admin_scope walks reports_to upward to tell an office owner
        # apart from an admin who leads a crew. It looks ids up as ObjectIds,
        # so key on the string form.
        return self.by_id.get(str(query.get("_id")))


class _BellsCollection:
    def __init__(self, sales_by_user):
        self.sales_by_user = sales_by_user

    def find(self, query, _projection):
        user_ids = query["user_id"]["$in"]
        rows = []
        for user_id in user_ids:
            sales = self.sales_by_user.get(user_id, 0)
            if sales:
                rows.append({
                    "days": [{
                        "status": "in",
                        "over30": sales,
                        "under30": 0,
                        "memberships": 0,
                    }],
                })
        return _Cursor(rows)


def test_team_member_scope_requires_someone_below_the_leader():
    assert bulletin._team_member_scope("leader-1", ["leader-1"]) is None

    scope = bulletin._team_member_scope(
        "leader-1",
        ["leader-1", "member-1", "member-1", "member-2"],
    )
    assert scope == (["leader-1", "member-1", "member-2"], 2)


def test_countrywide_team_builder_excludes_solo_leaders_and_caps_at_five(monkeypatch):
    leaders = [
        {
            "_id": f"leader-{index}",
            "name": f"Leader {index}",
            "team_name": f"Team {index}",
            "office_id": "office-1",
        }
        for index in range(7)
    ]
    leaders.append({
        "_id": "leader-blank",
        "name": "Blank Team Leader",
        "team_name": "   ",
        "office_id": "office-1",
    })
    leaders.append({
        "_id": "leader-inactive-only",
        "name": "Inactive Only Leader",
        "team_name": "Inactive Only Team",
        "office_id": "office-1",
    })
    subtrees = {
        "leader-0": ["leader-0"],  # named team, but no actual team member
        **{
            f"leader-{index}": [f"leader-{index}", f"member-{index}"]
            for index in range(1, 7)
        },
        "leader-blank": ["leader-blank", "member-blank"],
        "leader-inactive-only": ["leader-inactive-only", "inactive-member"],
    }
    # An inactive descendant with historical Bells must not inflate an otherwise
    # eligible team's total either.
    subtrees["leader-6"].append("inactive-sales-member")
    # Six eligible teams. Team 6 should rank first and only five may return.
    sales_by_user = {
        f"leader-{index}": index * 10
        for index in range(7)
    }
    sales_by_user["leader-blank"] = 999
    sales_by_user["leader-inactive-only"] = 888
    sales_by_user["inactive-sales-member"] = 1000

    active_user_ids = {
        *(f"leader-{index}" for index in range(7)),
        *(f"member-{index}" for index in range(1, 7)),
        "leader-blank",
        "member-blank",
        "leader-inactive-only",
        # inactive-member and inactive-sales-member intentionally omitted
    }

    fake_db = SimpleNamespace(
        users=_UsersCollection(leaders, active_user_ids),
        offices=_StaticCollection([{"id": "office-1", "name": "Boston"}]),
        bells_entries=_BellsCollection(sales_by_user),
    )

    async def fake_subtree(leader_id):
        return subtrees[leader_id]

    monkeypatch.setattr(bulletin, "db", fake_db)
    monkeypatch.setattr(bulletin, "get_subtree_ids", fake_subtree)

    result = asyncio.run(bulletin._build_top_teams("2026-07-12"))

    assert len(result) == bulletin.TOP_N == 5
    assert [team["rank"] for team in result] == [1, 2, 3, 4, 5]
    assert [team["team_name"] for team in result] == [
        "Team 6", "Team 5", "Team 4", "Team 3", "Team 2",
    ]
    assert all(team["member_count"] == 1 for team in result)
    assert result[0]["total_sales"] == 60
    assert "Team 0" not in {team["team_name"] for team in result}
    assert all(team["leader_name"] != "Blank Team Leader" for team in result)
    assert all(team["leader_name"] != "Inactive Only Leader" for team in result)


def test_an_admin_who_leads_a_crew_ranks_but_an_office_owner_does_not(monkeypatch):
    """Sep 2026: a team leader promoted to admin kept his crew. His team is a
    real team and belongs on the board; the office owner's "team" is the whole
    office and must stay off it (see core/admin_scope)."""
    # The upline walk resolves reports_to as an ObjectId, so these are real ones.
    owner_id, crew_id, leader_id, member_id = (str(ObjectId()) for _ in range(4))
    owner = {
        "_id": owner_id, "name": "Olivia", "team_name": "Summit",
        "office_id": "office-1", "role": "admin", "is_super_admin": True,
        "reports_to": None,
    }
    crew_admin = {
        "_id": crew_id, "name": "Marcus", "team_name": "North Stars",
        "office_id": "office-1", "role": "admin", "reports_to": owner_id,
    }
    plain_leader = {
        "_id": leader_id, "name": "Leo", "team_name": "KGE",
        "office_id": "office-1", "role": "leader", "reports_to": crew_id,
    }
    subtrees = {
        owner_id: [owner_id, crew_id, leader_id, member_id],
        crew_id: [crew_id, leader_id, member_id],
        leader_id: [leader_id, member_id],
    }
    sales_by_user = {owner_id: 5, crew_id: 7, leader_id: 3, member_id: 11}
    active_user_ids = {owner_id, crew_id, leader_id, member_id}

    fake_db = SimpleNamespace(
        users=_UsersCollection([owner, crew_admin, plain_leader], active_user_ids),
        offices=_StaticCollection([{"id": "office-1", "name": "Boston"}]),
        bells_entries=_BellsCollection(sales_by_user),
    )

    async def fake_subtree(leader_id):
        return subtrees[leader_id]

    monkeypatch.setattr(bulletin, "db", fake_db)
    monkeypatch.setattr(bulletin, "get_subtree_ids", fake_subtree)

    result = asyncio.run(bulletin._build_top_teams("2026-07-12"))
    names = [team["team_name"] for team in result]

    assert "North Stars" in names
    assert "KGE" in names
    assert "Summit" not in names
    thryve = next(t for t in result if t["team_name"] == "North Stars")
    # His whole active subtree counts, sub-leader included.
    assert thryve["total_sales"] == 21
    assert thryve["member_count"] == 2
